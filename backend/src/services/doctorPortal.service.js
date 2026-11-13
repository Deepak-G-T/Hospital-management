// The doctor's own portal: profile, schedule, consultations, patients, referrals, department messages, reviews.
// Appointments, emergencies, prescriptions, records and reports have their own services.
const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { notifyUser, notifyUsers } = require('./notification.service');
const { appointmentInclude } = require('./appointment.service');
const { emitToUsers } = require('../socket');
const { ACTIVE_EMERGENCY_STATUSES } = require('../utils/constants');
const { careRelationshipWhere, treatmentPatientIds, authorizeChart, authorizeWrite, summary } = require('../policies/patientAccess');
const { nameOnly, departmentName, departmentRef, doctorBrief, recordAuthor } = require('../db/selects');
const { paginateQuery } = require('../utils/pagination');

/** The doctor with their departments (used by emergency actions and messaging) */
const getDoctor = (doctorId) => prisma.doctor.findUnique({ where: { id: doctorId }, include: { departments: { include: { department: true } } } });

// ── Profile & schedule ──
const getProfile = (doctorId) => prisma.doctor.findUnique({
  where: { id: doctorId },
  include: { user: { select: { email: true } }, departments: { include: { department: departmentRef } }, availability: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] } },
});
const updateProfile = (doctorId, data) => prisma.doctor.update({ where: { id: doctorId }, data });

const getAvailability = (doctorId) => prisma.doctorAvailability.findMany({ where: { doctorId }, orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] });

/** Replaces the weekly schedule */
const setAvailability = (doctorId, slots) => prisma.$transaction(async (tx) => {
  await tx.doctorAvailability.deleteMany({ where: { doctorId } });
  await tx.doctorAvailability.createMany({ data: slots.map((s) => ({ ...s, doctorId })) });
  return tx.doctorAvailability.findMany({ where: { doctorId }, orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] });
});

// ── Consultation notes ──
/** Saves diagnosis/treatment/notes on one of the doctor's appointments; optionally adds the diagnosis to the history */
async function saveConsultation(actor, appointmentId, { addToHistory, ...data }) {
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt || appt.doctorId !== actor.profileId) throw ApiError.notFound('Appointment not found');
  if (['CANCELLED', 'REJECTED'].includes(appt.status)) throw ApiError.badRequest('Cannot add consultation notes to a cancelled appointment');
  const updated = await prisma.$transaction(async (tx) => {
    const a = await tx.appointment.update({ where: { id: appt.id }, data, include: appointmentInclude });
    if (addToHistory && data.diagnosis) {
      await tx.patientMedicalRecord.create({
        data: { patientId: appt.patientId, appointmentId: appt.id, createdByUserId: actor.id, recordType: 'DIAGNOSIS', title: data.diagnosis.slice(0, 200), description: data.treatment || null, diagnosedOn: new Date() },
      });
    }
    return a;
  });
  emitToUsers([updated.patient.userId], 'appointment:updated', updated);
  return updated;
}

// ── Patients ──
/**
 * Patients the doctor has a care relationship with, with their last visit to this doctor.
 * Blood group and the allergy count are clinical: they are included only for patients the doctor is treating now
 * (treatment or emergency access), exactly like the chart. For past-consultation patients they are left out.
 */
async function listPatients(doctorId, { search, treating: onlyTreating = false, page, limit } = {}) {
  const treating = await treatmentPatientIds(doctorId);
  // The care-relationship rule and the "only the patients I treat now" filter are part of the query, so they are applied BEFORE the page is cut
  const where = {
    AND: [
      careRelationshipWhere(doctorId),
      ...(search ? [{ fullName: { contains: search, mode: 'insensitive' } }] : []),
      ...(onlyTreating ? [{ id: { in: [...treating] } }] : []), // onlyTreating: the patients the doctor may prescribe for, refer or document now (the pickers)
    ],
  };
  return paginateQuery(prisma.patient, {
    where,
    select: {
      id: true, fullName: true, gender: true, dateOfBirth: true, bloodGroup: true, phone: true,
      _count: { select: { allergies: { where: { deletedAt: null } } } },
      appointments: { where: { doctorId }, orderBy: { startAt: 'desc' }, take: 1, select: { startAt: true, status: true } },
    },
    orderBy: { fullName: 'asc' },
  }, { page, limit }, { map: ({ bloodGroup, _count, ...p }) => (treating.has(p.id) ? { ...p, bloodGroup, _count } : p) });
}

/**
 * The clinical record of a patient as far as this doctor's relationship allows (see policies/patientAccess.js):
 * a treatment relationship shows everything the doctor needs for care; a past consultation only the records tied to it.
 * Sections the doctor may not see come back as empty lists, and `access` says what applies.
 */
async function getPatientRecord(actor, patientId) {
  const access = await authorizeChart(actor, patientId, 'PATIENT_CHART');
  const doctorId = actor.profileId;
  const s = access.sections;
  const own = (docField) => ({ OR: [{ [docField]: docField === 'createdByUserId' ? actor.id : doctorId }, { appointmentId: { in: access.appointmentIds } }] });
  const include = {
    user: { select: { email: true } },
    ...(s.allergies ? { allergies: { orderBy: { severity: 'desc' } } } : {}),
    ...(s.history ? { medicalRecords: { where: s.history === 'all' ? {} : own('createdByUserId'), orderBy: { createdAt: 'desc' }, include: { createdBy: recordAuthor } } } : {}),
    ...(s.prescriptions ? { prescriptions: { where: s.prescriptions === 'all' ? {} : own('doctorId'), orderBy: { createdAt: 'desc' }, include: { items: true, doctor: nameOnly } } } : {}),
    ...(s.reports ? { medicalReports: { where: s.reports === 'all' ? {} : own('doctorId'), orderBy: { createdAt: 'desc' }, include: { doctor: nameOnly } } } : {}),
    // The doctor's own consultations with this patient, not visits to other doctors or departments
    appointments: { where: { doctorId }, orderBy: { startAt: 'desc' }, take: 30, include: { doctor: nameOnly, department: departmentName } },
    // Emergencies this doctor handled, or is currently alerted to
    emergencyRequests: {
      where: { OR: [{ assignedDoctorId: doctorId }, { status: { in: ACTIVE_EMERGENCY_STATUSES }, notifications: { some: { doctorId } } }] },
      orderBy: { createdAt: 'desc' }, take: 10, include: { assignedDoctor: nameOnly },
    },
  };
  const patient = await prisma.patient.findUnique({ where: { id: patientId }, include });
  if (!patient) throw ApiError.notFound('Patient not found');
  return {
    ...patient,
    allergies: patient.allergies || [], medicalRecords: patient.medicalRecords || [],
    prescriptions: patient.prescriptions || [], medicalReports: patient.medicalReports || [],
    access: summary(access),
  };
}

// ── Referrals ──
const referralInclude = {
  patient: { select: { id: true, fullName: true, userId: true } },
  fromDoctor: doctorBrief,
  toDoctor: { select: { id: true, fullName: true, specialization: true, userId: true } },
  department: departmentRef,
};

/** Active colleagues the doctor can refer to, with their departments */
const colleagues = (doctorId) => prisma.doctor.findMany({
  where: { id: { not: doctorId }, user: { isActive: true } },
  select: { id: true, fullName: true, specialization: true, departments: { select: { department: departmentRef } } },
  orderBy: { fullName: 'asc' },
});

async function createReferral(actor, data) {
  const fromDoctorId = actor.profileId;
  if (data.toDoctorId === fromDoctorId) throw ApiError.badRequest('You cannot refer a patient to yourself');
  await authorizeWrite(actor, data.patientId, {}, 'REFERRAL_CREATE');
  const toDoctor = await prisma.doctor.findUnique({ where: { id: data.toDoctorId }, include: { user: { select: { isActive: true } } } });
  if (!toDoctor || !toDoctor.user.isActive) throw ApiError.notFound('Target doctor not found');
  const referral = await prisma.referral.create({ data: { ...data, fromDoctorId }, include: referralInclude });
  await notifyUser(toDoctor.userId, { type: 'REFERRAL', title: 'New patient referral', message: `Dr. ${actor.fullName} referred ${referral.patient.fullName}: ${referral.reason.slice(0, 120)}`, link: '/doctor/referrals' });
  await notifyUser(referral.patient.userId, { type: 'REFERRAL', title: 'You have been referred', message: `Dr. ${actor.fullName} referred you to Dr. ${toDoctor.fullName} (${toDoctor.specialization}). You can book an appointment with them.`, link: `/doctors/${toDoctor.id}` });
  return referral;
}

async function listReferrals(doctorId) {
  const [received, sent] = await Promise.all([
    prisma.referral.findMany({ where: { toDoctorId: doctorId }, include: referralInclude, orderBy: { createdAt: 'desc' } }),
    prisma.referral.findMany({ where: { fromDoctorId: doctorId }, include: referralInclude, orderBy: { createdAt: 'desc' } }),
  ]);
  return { received, sent };
}

/** Only the receiving doctor can accept/decline/complete; the referring doctor is notified */
async function updateReferral(actor, id, status) {
  const ref = await prisma.referral.findUnique({ where: { id }, include: referralInclude });
  if (!ref || ref.toDoctorId !== actor.profileId) throw ApiError.notFound('Referral not found');
  const updated = await prisma.referral.update({ where: { id: ref.id }, data: { status }, include: referralInclude });
  const from = await prisma.doctor.findUnique({ where: { id: ref.fromDoctorId }, select: { userId: true } });
  await notifyUser(from.userId, { type: 'REFERRAL', title: `Referral ${status.toLowerCase()}`, message: `Dr. ${actor.fullName} ${status.toLowerCase()} the referral for ${ref.patient.fullName}.`, link: '/doctor/referrals' });
  return updated;
}

// ── Inter-department messages ──
const messageInclude = { sender: doctorBrief, fromDepartment: departmentRef, toDepartment: departmentRef };

async function listMessages(doctorId) {
  const doctor = await getDoctor(doctorId);
  const deptIds = doctor.departments.map((d) => d.departmentId);
  const [inbox, sent] = await Promise.all([
    prisma.departmentMessage.findMany({ where: { toDepartmentId: { in: deptIds }, senderDoctorId: { not: doctor.id } }, include: messageInclude, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.departmentMessage.findMany({ where: { senderDoctorId: doctor.id }, include: messageInclude, orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);
  return { inbox, sent, myDepartments: doctor.departments.map((d) => d.department) };
}

/** Sends to a department on behalf of one of the doctor's departments (primary by default); its doctors are notified */
async function sendMessage(doctorId, data) {
  const doctor = await getDoctor(doctorId);
  const toDept = await prisma.department.findUnique({ where: { id: data.toDepartmentId } });
  if (!toDept) throw ApiError.notFound('Department not found');
  const fromDepartmentId = data.fromDepartmentId && doctor.departments.some((d) => d.departmentId === data.fromDepartmentId)
    ? data.fromDepartmentId : doctor.departments.find((d) => d.isPrimary)?.departmentId || doctor.departments[0]?.departmentId || null;
  const message = await prisma.departmentMessage.create({ data: { ...data, fromDepartmentId, senderDoctorId: doctor.id } });
  const recipients = await prisma.doctor.findMany({ where: { departments: { some: { departmentId: toDept.id } }, id: { not: doctor.id }, user: { isActive: true } }, select: { userId: true } });
  await notifyUsers(recipients.map((r) => r.userId), { type: 'MESSAGE', title: `Message to ${toDept.name}`, message: `Dr. ${doctor.fullName}: ${data.subject}`, link: '/doctor/messages' });
  return { message, toDepartmentId: toDept.id };
}

// ── Reviews ──
async function listReviews(doctorId, query = {}) {
  const [page, agg, byRating] = await Promise.all([
    paginateQuery(prisma.doctorReview, { where: { doctorId }, orderBy: { createdAt: 'desc' }, include: { patient: nameOnly, appointment: { select: { startAt: true } } } }, query),
    prisma.doctorReview.aggregate({ where: { doctorId }, _avg: { rating: true }, _count: { rating: true } }),
    prisma.doctorReview.groupBy({ by: ['rating'], where: { doctorId }, _count: { rating: true } }), // the distribution is counted by the database, not from the loaded rows
  ]);
  const counts = Object.fromEntries(byRating.map((r) => [r.rating, r._count.rating]));
  const distribution = [5, 4, 3, 2, 1].map((r) => ({ rating: r, count: counts[r] || 0 }));
  return { ...page, average: agg._avg.rating ? Number(agg._avg.rating.toFixed(2)) : null, total: agg._count.rating, distribution };
}

module.exports = {
  getDoctor, getProfile, updateProfile, getAvailability, setAvailability, saveConsultation, listPatients, getPatientRecord,
  colleagues, createReferral, listReferrals, updateReferral, listMessages, sendMessage, listReviews,
};
