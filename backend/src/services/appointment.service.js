const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { assertValidSlot } = require('./slot.service');
const { notifyUser, notifyAdmins } = require('./notification.service');
const { emitToUsers, emitToRole } = require('../socket');
const { ACTIVE_APPOINTMENT_STATUSES } = require('../utils/constants');
const { parseDateOnly, startOfDay, endOfDay } = require('../utils/dates');
const { paginateQuery } = require('../utils/pagination');

const appointmentInclude = {
  patient: { select: { id: true, fullName: true, phone: true, userId: true, gender: true, dateOfBirth: true } },
  doctor: { select: { id: true, fullName: true, specialization: true, userId: true, avatarUrl: true, consultationFee: true } },
  department: { select: { id: true, name: true } },
  review: true,
  prescriptions: { select: { id: true, prescriptionNumber: true, createdAt: true } },
};

// Allowed status transitions per role
const TRANSITIONS = {
  DOCTOR: { PENDING: ['CONFIRMED', 'REJECTED'], CONFIRMED: ['COMPLETED', 'NO_SHOW', 'CANCELLED'] },
  ADMIN: { PENDING: ['CONFIRMED', 'REJECTED', 'CANCELLED'], CONFIRMED: ['COMPLETED', 'NO_SHOW', 'CANCELLED'] },
  PATIENT: { PENDING: ['CANCELLED'], CONFIRMED: ['CANCELLED'] },
};

const fmt = (d) => new Date(d).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * What administrators see of an appointment: scheduling and status data only. The doctor's diagnosis, treatment and
 * clinical notes belong to the patient and their doctor, so they are never sent to the admin role (API, socket, dashboard).
 */
const adminView = ({ diagnosis, treatment, notes, ...operational }) => operational; // eslint-disable-line no-unused-vars

function broadcastAppointment(appt) {
  emitToUsers([appt.patient.userId, appt.doctor.userId], 'appointment:updated', appt);
  emitToRole('ADMIN', 'appointment:updated', adminView(appt));
}

async function resolveDepartmentId(doctorId, departmentId) {
  const links = await prisma.doctorDepartment.findMany({ where: { doctorId }, orderBy: { isPrimary: 'desc' } });
  if (departmentId) {
    if (!links.some((l) => l.departmentId === departmentId)) throw ApiError.badRequest('Doctor does not belong to the selected department');
    return departmentId;
  }
  return links[0]?.departmentId || null;
}

/** Books an appointment inside a SERIALIZABLE transaction; the partial unique index is the final guard. */
async function bookAppointment({ patientId, doctorId, departmentId, startAt, reason, type = 'CONSULTATION' }) {
  const doctor = await prisma.doctor.findUnique({ where: { id: doctorId }, include: { user: { select: { isActive: true } } } });
  if (!doctor || !doctor.user.isActive) throw ApiError.notFound('Doctor not found');
  const endAt = await assertValidSlot(doctorId, startAt);
  const deptId = await resolveDepartmentId(doctorId, departmentId);
  const start = new Date(startAt);

  const appt = await prisma.$transaction(async (tx) => {
    const doctorConflict = await tx.appointment.findFirst({
      where: { doctorId, status: { in: ACTIVE_APPOINTMENT_STATUSES }, startAt: { lt: endAt }, endAt: { gt: start } },
    });
    if (doctorConflict) throw ApiError.conflict('This time slot has already been booked. Please pick another slot.');
    const patientConflict = await tx.appointment.findFirst({
      where: { patientId, status: { in: ACTIVE_APPOINTMENT_STATUSES }, startAt: { lt: endAt }, endAt: { gt: start } },
    });
    if (patientConflict) throw ApiError.conflict('You already have another appointment at this time');
    return tx.appointment.create({
      data: { patientId, doctorId, departmentId: deptId, startAt: start, endAt, reason, type },
      include: appointmentInclude,
    });
  }, { isolationLevel: 'Serializable' });

  await notifyUser(appt.doctor.userId, {
    type: 'APPOINTMENT', title: 'New appointment request',
    message: `${appt.patient.fullName} requested an appointment on ${fmt(appt.startAt)}.`, link: '/doctor/appointments',
  });
  await notifyAdmins({
    type: 'APPOINTMENT', title: 'New appointment booked',
    message: `${appt.patient.fullName} booked Dr. ${appt.doctor.fullName} for ${fmt(appt.startAt)}.`, link: '/admin/appointments',
  });
  broadcastAppointment(appt);
  return appt;
}

/** Applies a status change after checking the role's allowed transitions */
async function changeStatus({ appointmentId, actor, status, reason }) {
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId }, include: appointmentInclude });
  if (!appt) throw ApiError.notFound('Appointment not found');
  if (actor.role === 'DOCTOR' && appt.doctorId !== actor.profileId) throw ApiError.forbidden();
  if (actor.role === 'PATIENT' && appt.patientId !== actor.profileId) throw ApiError.forbidden();

  const allowed = TRANSITIONS[actor.role][appt.status] || [];
  if (!allowed.includes(status)) throw ApiError.badRequest(`Cannot change appointment from ${appt.status} to ${status}`);
  if (['COMPLETED', 'NO_SHOW'].includes(status) && appt.startAt > new Date()) {
    throw ApiError.badRequest('An appointment can only be completed after its start time');
  }

  const data = { status, statusReason: reason || null };
  if (status === 'COMPLETED') data.completedAt = new Date();
  if (status === 'CANCELLED') data.cancelledAt = new Date();
  if (status === 'CONFIRMED' && actor.role === 'ADMIN') data.approvedByAdmin = true;

  // Optimistic concurrency: only update if status is still what we read
  const result = await prisma.appointment.updateMany({ where: { id: appointmentId, status: appt.status }, data });
  if (!result.count) throw ApiError.conflict('Appointment was updated by someone else. Please refresh.');
  const updated = await prisma.appointment.findUnique({ where: { id: appointmentId }, include: appointmentInclude });

  const labels = { CONFIRMED: 'confirmed', REJECTED: 'rejected', CANCELLED: 'cancelled', COMPLETED: 'completed', NO_SHOW: 'marked as no-show' };
  const by = actor.role === 'ADMIN' ? 'the hospital administration' : actor.role === 'DOCTOR' ? `Dr. ${updated.doctor.fullName}` : updated.patient.fullName;
  const msg = `Appointment on ${fmt(updated.startAt)} was ${labels[status]} by ${by}${reason ? `: ${reason}` : '.'}`;

  if (actor.role !== 'PATIENT') {
    await notifyUser(updated.patient.userId, { type: 'APPOINTMENT', title: `Appointment ${labels[status]}`, message: msg, link: '/patient/appointments' });
  }
  if (actor.role !== 'DOCTOR') {
    await notifyUser(updated.doctor.userId, { type: 'APPOINTMENT', title: `Appointment ${labels[status]}`, message: msg, link: '/doctor/appointments' });
  }
  broadcastAppointment(updated);
  return updated;
}

async function reschedule({ appointmentId, actor, startAt }) {
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId }, include: appointmentInclude });
  if (!appt) throw ApiError.notFound('Appointment not found');
  if (actor.role === 'PATIENT' && appt.patientId !== actor.profileId) throw ApiError.forbidden();
  if (!ACTIVE_APPOINTMENT_STATUSES.includes(appt.status)) throw ApiError.badRequest('Only pending or confirmed appointments can be rescheduled');
  if (appt.rescheduledCount >= 3) throw ApiError.badRequest('This appointment has been rescheduled too many times');

  const endAt = await assertValidSlot(appt.doctorId, startAt);
  const start = new Date(startAt);

  const updated = await prisma.$transaction(async (tx) => {
    const conflict = await tx.appointment.findFirst({
      where: { id: { not: appointmentId }, doctorId: appt.doctorId, status: { in: ACTIVE_APPOINTMENT_STATUSES }, startAt: { lt: endAt }, endAt: { gt: start } },
    });
    if (conflict) throw ApiError.conflict('This time slot has already been booked');
    // A rescheduled appointment goes back to PENDING so the doctor re-confirms it
    return tx.appointment.update({
      where: { id: appointmentId },
      data: { startAt: start, endAt, status: 'PENDING', rescheduledCount: { increment: 1 }, approvedByAdmin: false },
      include: appointmentInclude,
    });
  }, { isolationLevel: 'Serializable' });

  await notifyUser(updated.doctor.userId, {
    type: 'APPOINTMENT', title: 'Appointment rescheduled',
    message: `${updated.patient.fullName} moved their appointment from ${fmt(appt.startAt)} to ${fmt(updated.startAt)}. Please confirm.`,
    link: '/doctor/appointments',
  });
  broadcastAppointment(updated);
  return updated;
}

// ── Lists ──
async function pagedList(where, query, orderBy, map = (a) => a) {
  return paginateQuery(prisma.appointment, { where, include: appointmentInclude, orderBy }, query, { map });
}
const dateRangeOn = (where, q) => {
  if (q.from || q.to) {
    where.startAt = { ...(where.startAt || {}) };
    if (q.from) where.startAt.gte = startOfDay(parseDateOnly(q.from));
    if (q.to) where.startAt.lte = endOfDay(parseDateOnly(q.to));
  }
};

/** Admin: every appointment, filtered by status/doctor/department/date/search */
function listForAdmin(q) {
  const where = {};
  if (q.status) where.status = q.status;
  if (q.doctorId) where.doctorId = q.doctorId;
  if (q.departmentId) where.departmentId = q.departmentId;
  dateRangeOn(where, q);
  if (q.search) {
    where.OR = [
      { patient: { fullName: { contains: q.search, mode: 'insensitive' } } },
      { doctor: { fullName: { contains: q.search, mode: 'insensitive' } } },
      { reason: { contains: q.search, mode: 'insensitive' } },
    ];
  }
  return pagedList(where, q, { startAt: 'desc' }, adminView);
}

/** Doctor: own appointments by scope (today / upcoming / past), status, dates and patient name */
function listForDoctor(doctorId, q) {
  const now = new Date();
  const where = { doctorId };
  if (q.status) where.status = q.status;
  if (q.scope === 'today') where.startAt = { gte: startOfDay(now), lte: endOfDay(now) };
  else if (q.scope === 'upcoming') where.startAt = { gte: now };
  else if (q.scope === 'past') where.startAt = { lt: now };
  dateRangeOn(where, q);
  if (q.search) where.patient = { fullName: { contains: q.search, mode: 'insensitive' } };
  return pagedList(where, q, { startAt: q.scope === 'past' ? 'desc' : 'asc' });
}

/** Patient: own appointments by scope (upcoming / past) and status */
function listForPatient(patientId, q) {
  const now = new Date();
  const where = { patientId };
  if (q.status) where.status = q.status;
  if (q.scope === 'upcoming') { where.startAt = { gte: now }; where.status = where.status || { in: ['PENDING', 'CONFIRMED'] }; }
  if (q.scope === 'past') where.OR = [{ startAt: { lt: now } }, { status: { in: ['COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW'] } }];
  return pagedList(where, q, { startAt: q.scope === 'upcoming' ? 'asc' : 'desc' });
}

module.exports = { bookAppointment, changeStatus, reschedule, appointmentInclude, adminView, broadcastAppointment, listForAdmin, listForDoctor, listForPatient };
