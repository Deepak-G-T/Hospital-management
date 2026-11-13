const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { notifyUsers, notifyUser, notifyAdmins } = require('./notification.service');
const { emitToRole, emitToUsers, emitToDoctor } = require('../socket');
const { ACTIVE_EMERGENCY_STATUSES, OPEN_EMERGENCY_STATUSES, PRIORITY_ORDER } = require('../utils/constants');
const { toMinutes } = require('../utils/dates');
const { paginateQuery } = require('../utils/pagination');
const escalation = require('./escalation.service');
const { emergencyRef } = require('../utils/emergencyRef');
const { auditStrict, auditStrictMany } = require('./audit.service');
const { hasReason, requireReason } = require('../policies/patientAccess');
const { currentRequest } = require('../utils/requestContext');
const { emergencyAuditWindowMinutes } = require('../config/recordAccess');
const { config: escalationConfig, targetMinutes } = require('../config/escalation');

const emergencyInclude = {
  patient: {
    select: {
      id: true, fullName: true, phone: true, userId: true, bloodGroup: true, dateOfBirth: true, gender: true,
      emergencyContactName: true, emergencyContactPhone: true,
      allergies: { where: { deletedAt: null }, select: { allergen: true, type: true, severity: true } },
    },
  },
  department: { select: { id: true, name: true } },
  assignedDoctor: { select: { id: true, fullName: true, specialization: true, phone: true, userId: true } },
  notifications: { include: { doctor: { select: { id: true, fullName: true, specialization: true } } }, orderBy: { sentAt: 'asc' } },
  events: { orderBy: { createdAt: 'asc' }, include: { actor: { select: { role: true, email: true } } } },
  acknowledgedBy: { select: { role: true, email: true } },
  escalations: { orderBy: { level: 'asc' }, select: { level: true, priority: true, targetMinutes: true, dueAt: true, notifiedDoctors: true, notifiedAdmins: true, createdAt: true } },
};

async function addEvent(emergencyId, eventType, message, actorUserId = null) {
  return prisma.emergencyEvent.create({ data: { emergencyId, eventType, message, actorUserId } });
}

/** Step 3 of the workflow: identify the most relevant department from the symptoms */
async function identifyDepartment(symptoms, requestedDepartmentId) {
  if (requestedDepartmentId) {
    const dept = await prisma.department.findFirst({ where: { id: requestedDepartmentId, isActive: true } });
    if (dept) return { department: dept, method: 'Selected by patient' };
  }
  const departments = await prisma.department.findMany({ where: { isActive: true } });
  const text = symptoms.toLowerCase();
  let best = null; let bestScore = 0;
  for (const d of departments) {
    const keywords = (d.keywords || '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
    const score = keywords.reduce((acc, k) => acc + (text.includes(k) ? k.length : 0), 0);
    if (score > bestScore) { best = d; bestScore = score; }
  }
  if (best) return { department: best, method: 'Matched from symptoms' };
  const fallback = departments.find((d) => d.isEmergency) || departments[0] || null;
  return { department: fallback, method: 'Default emergency department' };
}

function isOnShift(availability, now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  return availability.some((a) => a.isActive && a.dayOfWeek === now.getDay() && toMinutes(a.startTime) <= minutes && minutes < toMinutes(a.endTime));
}

/** Step 4: find doctors who should be alerted. Prefers on-shift doctors in the department. */
async function findAvailableDoctors(departmentId, { excludeDoctorIds = [], widen = false } = {}) {
  const base = { isAvailableForEmergency: true, user: { isActive: true }, id: { notIn: excludeDoctorIds } };
  const select = { id: true, userId: true, fullName: true, availability: true };

  let doctors = departmentId && !widen
    ? await prisma.doctor.findMany({ where: { ...base, departments: { some: { departmentId } } }, select })
    : [];

  if (!doctors.length || widen) {
    // Widen to the emergency department, then to everyone flagged for emergencies
    const emergencyDocs = await prisma.doctor.findMany({ where: { ...base, departments: { some: { department: { isEmergency: true } } } }, select });
    doctors = [...doctors, ...emergencyDocs];
  }
  if (!doctors.length || widen) {
    doctors = [...doctors, ...(await prisma.doctor.findMany({ where: base, select }))];
  }
  const unique = [...new Map(doctors.map((d) => [d.id, d])).values()];
  const onShift = unique.filter((d) => isOnShift(d.availability));
  return widen ? unique : (onShift.length ? onShift : unique);
}

// Notification texts and socket payloads never carry symptoms or other clinical details: the stored notification is generic
// and the doctor opens the emergency board (an authorised view) to read the case.
async function alertDoctors(emergency, doctors, label) {
  if (!doctors.length) return 0;
  await prisma.emergencyNotification.createMany({
    data: doctors.map((d) => ({ emergencyId: emergency.id, doctorId: d.id })),
    skipDuplicates: true,
  });
  await notifyUsers(doctors.map((d) => d.userId), {
    type: 'EMERGENCY',
    title: `${emergency.priority} emergency alert`,
    message: `${label} requires attention — open the emergency board (ref ${emergencyRef(emergency.id)}).`,
    link: '/doctor/emergencies',
  });
  doctors.forEach((d) => emitToDoctor(d.id, 'emergency:alert', { id: emergency.id, priority: emergency.priority }));
  return doctors.length;
}

async function loadFull(id) {
  return prisma.emergencyRequest.findUnique({ where: { id }, include: emergencyInclude });
}

/**
 * What administrators see by default: the emergency without the patient's allergy list. Registration data (name, phone,
 * blood group, emergency contact) is operational and stays; clinical details need a reason (getForAdmin).
 */
function adminView(full) {
  const { allergies, ...patient } = full.patient; // eslint-disable-line no-unused-vars
  return { ...full, patient: { ...patient, clinicalWithheld: true } };
}

function broadcast(full) {
  const open = ACTIVE_EMERGENCY_STATUSES.includes(full.status);
  emitToRole('ADMIN', 'emergency:updated', adminView(full));
  // Doctors who were only alerted lose access once the emergency closes: they get a minimal "closed" update, no patient data
  const doctorIds = [...new Set(full.notifications.map((n) => n.doctor && n.doctor.id).filter(Boolean))];
  doctorIds.forEach((doctorId) => emitToDoctor(doctorId, 'emergency:updated', open || full.assignedDoctorId === doctorId ? full : { id: full.id, status: full.status, closed: true }));
  emitToUsers([full.patient.userId], 'emergency:updated', full);
}

/** Starts the automatic-escalation clock for a new emergency (only while the escalation worker is enabled) */
async function scheduleAutoEscalation(id, priority) {
  if (!escalationConfig.enabled) return;
  if (await escalation.scheduleFirst(id, priority)) {
    await addEvent(id, 'ESCALATION_SCHEDULED', `Automatic escalation active: if no doctor accepts within ${targetMinutes(priority)} minute(s) (provisional ${priority} target), more staff will be alerted. Priority is never changed automatically.`);
  }
}

/** Workflow steps 1–4: patient submits, admin alerted, department identified, doctors notified */
async function createEmergency(patient, user, input) {
  const active = await prisma.emergencyRequest.findFirst({ where: { patientId: patient.id, status: { in: ACTIVE_EMERGENCY_STATUSES } } });
  if (active) throw ApiError.conflict('You already have an active emergency request. Please check its status.');

  const { department, method } = await identifyDepartment(input.symptoms, input.departmentId);
  const consent = Boolean(input.locationConsent);

  const emergency = await prisma.emergencyRequest.create({
    data: {
      patientId: patient.id,
      departmentId: department?.id || null,
      priority: input.priority,
      symptoms: input.symptoms,
      description: input.description || null,
      contactPhone: input.contactPhone || patient.phone || null,
      locationConsent: consent,
      latitude: consent ? input.latitude ?? null : null,
      longitude: consent ? input.longitude ?? null : null,
      address: input.address || null,
    },
  });
  await addEvent(emergency.id, 'CREATED', `Emergency submitted by patient with ${input.priority} priority`, user.id);
  if (department) await addEvent(emergency.id, 'DEPARTMENT_IDENTIFIED', `${department.name} (${method})`);

  await notifyAdmins({
    type: 'EMERGENCY', title: `New ${input.priority} emergency`,
    message: `New emergency request requires attention (ref ${emergencyRef(emergency.id)}).`, link: '/admin/emergencies',
  });

  const doctors = await findAvailableDoctors(department?.id, { widen: input.priority === 'CRITICAL' });
  const count = await alertDoctors(emergency, doctors, 'New emergency request');
  await prisma.emergencyRequest.update({
    where: { id: emergency.id },
    data: { status: count ? 'NOTIFIED' : 'PENDING', notifiedAt: count ? new Date() : null },
  });
  await addEvent(emergency.id, 'DOCTORS_NOTIFIED', count ? `${count} available doctor(s) alerted` : 'No available doctors found — awaiting admin assignment');
  await scheduleAutoEscalation(emergency.id, input.priority);

  const full = await loadFull(emergency.id);
  broadcast(full);
  emitToRole('ADMIN', 'emergency:new', adminView(full));
  return full;
}

/** Step 5a: doctor accepts. Atomic so two doctors cannot both accept the same case. */
async function acceptEmergency(id, doctor, user, note) {
  // Accepting gives access to the patient's records, so only doctors who were alerted for this emergency may accept it
  const current = await prisma.emergencyRequest.findUnique({ where: { id }, select: { status: true } });
  if (!current) throw ApiError.notFound('Emergency not found');
  if (OPEN_EMERGENCY_STATUSES.includes(current.status)) {
    const alerted = await prisma.emergencyNotification.findUnique({ where: { emergencyId_doctorId: { emergencyId: id, doctorId: doctor.id } }, select: { id: true } });
    if (!alerted) throw ApiError.forbidden('You were not alerted for this emergency. Ask an administrator to assign it.');
  }
  const result = await prisma.emergencyRequest.updateMany({
    where: { id, status: { in: OPEN_EMERGENCY_STATUSES } },
    data: { status: 'ACCEPTED', assignedDoctorId: doctor.id, acceptedAt: new Date(), ...escalation.STOP },
  });
  if (!result.count) throw ApiError.conflict('This emergency has already been accepted or closed');

  await prisma.$transaction([
    prisma.emergencyNotification.upsert({
      where: { emergencyId_doctorId: { emergencyId: id, doctorId: doctor.id } },
      create: { emergencyId: id, doctorId: doctor.id, status: 'ACCEPTED', respondedAt: new Date(), responseNote: note || null },
      update: { status: 'ACCEPTED', respondedAt: new Date(), responseNote: note || null },
    }),
    prisma.emergencyNotification.updateMany({ where: { emergencyId: id, doctorId: { not: doctor.id }, status: { in: ['SENT', 'SEEN'] } }, data: { status: 'EXPIRED' } }),
  ]);
  await addEvent(id, 'ACCEPTED', `Accepted by Dr. ${doctor.fullName}${note ? ` — ${note}` : ''}`, user.id);

  const full = await loadFull(id);
  await notifyUser(full.patient.userId, {
    type: 'EMERGENCY', title: 'A doctor has accepted your emergency',
    message: `Dr. ${doctor.fullName} is handling your request.`, link: '/patient/emergency',
  });
  await notifyAdmins({ type: 'EMERGENCY', title: 'Emergency accepted', message: `Dr. ${doctor.fullName} accepted ${full.patient.fullName}'s ${full.priority} emergency.`, link: '/admin/emergencies' });
  broadcast(full);
  return full;
}

/**
 * Step 5b: doctor escalates by hand — a human decision that raises priority/level and widens the alert.
 * Returns { emergency, priorityChange: { from, to } } so the caller can audit the priority change.
 */
async function escalateEmergencyDetailed(id, doctor, user, reason) {
  const em = await prisma.emergencyRequest.findUnique({ where: { id } });
  if (!em) throw ApiError.notFound('Emergency not found');
  if (!ACTIVE_EMERGENCY_STATUSES.includes(em.status)) throw ApiError.badRequest('This emergency is already closed');
  if (em.status === 'ACCEPTED' && em.assignedDoctorId !== doctor.id) throw ApiError.forbidden('Only the assigned doctor can escalate an accepted case');
  const wasNotified = await prisma.emergencyNotification.findUnique({ where: { emergencyId_doctorId: { emergencyId: id, doctorId: doctor.id } } });
  if (!wasNotified && em.assignedDoctorId !== doctor.id) throw ApiError.forbidden('You were not alerted for this emergency');

  const idx = PRIORITY_ORDER.indexOf(em.priority);
  const newPriority = PRIORITY_ORDER[Math.min(idx + 1, PRIORITY_ORDER.length - 1)];

  await prisma.$transaction([
    prisma.emergencyRequest.update({
      where: { id },
      data: { status: 'ESCALATED', priority: newPriority, escalationLevel: { increment: 1 }, escalationReason: reason, assignedDoctorId: null, acceptedAt: null },
    }),
    prisma.emergencyNotification.update({
      where: { emergencyId_doctorId: { emergencyId: id, doctorId: doctor.id } },
      data: { status: 'ESCALATED', respondedAt: new Date(), responseNote: reason },
    }),
  ]);
  await addEvent(id, 'ESCALATED', `Escalated by Dr. ${doctor.fullName} (priority ${em.priority} → ${newPriority}): ${reason}`, user.id);

  const already = await prisma.emergencyNotification.findMany({ where: { emergencyId: id }, select: { doctorId: true } });
  const exclude = already.map((n) => n.doctorId);
  const updatedEm = await prisma.emergencyRequest.findUnique({ where: { id } });
  const doctors = await findAvailableDoctors(em.departmentId, { excludeDoctorIds: exclude, widen: true });
  // Doctors already alerted but not escalating get re-alerted as well
  await prisma.emergencyNotification.updateMany({ where: { emergencyId: id, status: { in: ['SENT', 'SEEN', 'EXPIRED'] } }, data: { status: 'SENT' } });
  const count = await alertDoctors(updatedEm, doctors, `Escalated emergency (level ${updatedEm.escalationLevel})`);
  await addEvent(id, 'DOCTORS_NOTIFIED', `Escalation alert sent to ${count} additional doctor(s)`);
  // The case is waiting for a doctor again: restart the automatic-escalation clock for the (new) priority
  if (escalationConfig.enabled) await escalation.restartClock(id, newPriority);

  await notifyAdmins({ type: 'EMERGENCY', title: 'Emergency escalated', message: `Dr. ${doctor.fullName} escalated an emergency to ${newPriority} (ref ${emergencyRef(id)}). The reason is on the emergency timeline.`, link: '/admin/emergencies' });
  const full = await loadFull(id);
  await notifyUser(full.patient.userId, { type: 'EMERGENCY', title: 'Emergency escalated', message: 'Your request has been escalated to additional specialists.', link: '/patient/emergency' });
  broadcast(full);
  return { emergency: full, priorityChange: { from: em.priority, to: newPriority } };
}
const escalateEmergency = async (...args) => (await escalateEmergencyDetailed(...args)).emergency;

async function resolveEmergency(id, actor, notes) {
  const em = await prisma.emergencyRequest.findUnique({ where: { id } });
  if (!em) throw ApiError.notFound('Emergency not found');
  if (actor.role === 'DOCTOR' && em.assignedDoctorId !== actor.profileId) throw ApiError.forbidden('Only the assigned doctor can resolve this case');
  if (!ACTIVE_EMERGENCY_STATUSES.includes(em.status)) throw ApiError.badRequest('Emergency already closed');
  await prisma.emergencyRequest.update({ where: { id }, data: { status: 'RESOLVED', resolvedAt: new Date(), resolutionNotes: notes || null, ...escalation.STOP } });
  await addEvent(id, 'RESOLVED', `Resolved by ${actor.role === 'ADMIN' ? 'admin' : `Dr. ${actor.fullName}`}${notes ? `: ${notes}` : ''}`, actor.id);
  const full = await loadFull(id);
  await notifyUser(full.patient.userId, { type: 'EMERGENCY', title: 'Emergency resolved', message: notes || 'Your emergency request has been marked as resolved.', link: '/patient/emergency' });
  if (actor.role !== 'ADMIN') await notifyAdmins({ type: 'EMERGENCY', title: 'Emergency resolved', message: `${full.patient.fullName}'s emergency was resolved.`, link: '/admin/emergencies' });
  broadcast(full);
  return full;
}

async function cancelEmergency(id, patient, user) {
  const result = await prisma.emergencyRequest.updateMany({
    where: { id, patientId: patient.id, status: { in: ACTIVE_EMERGENCY_STATUSES } },
    data: { status: 'CANCELLED', resolvedAt: new Date(), ...escalation.STOP },
  });
  if (!result.count) throw ApiError.badRequest('Emergency cannot be cancelled');
  await prisma.emergencyNotification.updateMany({ where: { emergencyId: id, status: { in: ['SENT', 'SEEN'] } }, data: { status: 'EXPIRED' } });
  await addEvent(id, 'CANCELLED', 'Cancelled by patient', user.id);
  const full = await loadFull(id);
  await notifyAdmins({ type: 'EMERGENCY', title: 'Emergency cancelled', message: `${patient.fullName} cancelled their emergency request.`, link: '/admin/emergencies' });
  if (full.assignedDoctor) await notifyUser(full.assignedDoctor.userId, { type: 'EMERGENCY', title: 'Emergency cancelled', message: `${patient.fullName} cancelled their emergency request.`, link: '/doctor/emergencies' });
  broadcast(full);
  return full;
}

/**
 * Admin oversight (step 6): reassign department, assign a doctor directly, change priority or re-alert.
 * Returns { emergency, priorityChange: { from, to } | null } so the caller can audit a priority change.
 */
async function adminUpdateDetailed(id, admin, input) {
  const em = await prisma.emergencyRequest.findUnique({ where: { id } });
  if (!em) throw ApiError.notFound('Emergency not found');
  if (!ACTIVE_EMERGENCY_STATUSES.includes(em.status)) throw ApiError.badRequest('Emergency already closed');
  const data = {};
  const notes = [];

  if (input.priority && input.priority !== em.priority) { data.priority = input.priority; notes.push(`priority ${em.priority} → ${input.priority}`); }
  if (input.departmentId && input.departmentId !== em.departmentId) {
    const dept = await prisma.department.findUnique({ where: { id: input.departmentId } });
    if (!dept) throw ApiError.notFound('Department not found');
    data.departmentId = dept.id; notes.push(`department → ${dept.name}`);
  }
  if (input.assignDoctorId) {
    const doc = await prisma.doctor.findUnique({ where: { id: input.assignDoctorId } });
    if (!doc) throw ApiError.notFound('Doctor not found');
    data.assignedDoctorId = doc.id; data.status = 'ACCEPTED'; data.acceptedAt = new Date(); Object.assign(data, escalation.STOP);
    notes.push(`assigned to Dr. ${doc.fullName}`);
    await prisma.emergencyNotification.upsert({
      where: { emergencyId_doctorId: { emergencyId: id, doctorId: doc.id } },
      create: { emergencyId: id, doctorId: doc.id, status: 'ACCEPTED', respondedAt: new Date(), responseNote: 'Assigned by admin' },
      update: { status: 'ACCEPTED', respondedAt: new Date(), responseNote: 'Assigned by admin' },
    });
    await notifyUser(doc.userId, { type: 'EMERGENCY', title: 'Emergency assigned to you', message: `Admin assigned you a ${data.priority || em.priority} emergency (ref ${emergencyRef(id)}). Open the emergency board.`, link: '/doctor/emergencies' });
  }
  if (Object.keys(data).length) await prisma.emergencyRequest.update({ where: { id }, data });
  if (notes.length) await addEvent(id, 'ADMIN_UPDATE', `Admin ${admin.fullName}: ${notes.join(', ')}`, admin.id);
  // A human changed the priority of a case still waiting for a doctor: the next automatic step follows the new target
  if (data.priority && !data.assignedDoctorId && escalationConfig.enabled) await escalation.restartClock(id, data.priority);

  if (input.renotify && !input.assignDoctorId) {
    const current = await prisma.emergencyRequest.findUnique({ where: { id } });
    const already = await prisma.emergencyNotification.findMany({ where: { emergencyId: id }, select: { doctorId: true } });
    const doctors = await findAvailableDoctors(current.departmentId, { excludeDoctorIds: already.map((a) => a.doctorId) });
    const count = await alertDoctors(current, doctors, 'Emergency re-alert');
    if (current.status === 'PENDING' && count) await prisma.emergencyRequest.update({ where: { id }, data: { status: 'NOTIFIED', notifiedAt: new Date() } });
    await addEvent(id, 'DOCTORS_NOTIFIED', `Admin re-alerted ${count} doctor(s)`, admin.id);
  }

  const full = await loadFull(id);
  if (notes.length) await notifyUser(full.patient.userId, { type: 'EMERGENCY', title: 'Emergency updated', message: `Your emergency request was updated: ${notes.join(', ')}`, link: '/patient/emergency' });
  broadcast(full);
  return { emergency: full, priorityChange: data.priority ? { from: em.priority, to: data.priority } : null };
}
const adminUpdate = async (...args) => (await adminUpdateDetailed(...args)).emergency;

async function markSeen(id, doctorId) {
  await prisma.emergencyNotification.updateMany({ where: { emergencyId: id, doctorId, status: 'SENT' }, data: { status: 'SEEN' } });
}

// ── Lists ──
/** Admin: all emergencies, filtered by status ("active" = still open), priority and department. No allergy list (see adminView). */
async function listForAdmin(q) {
  const where = {
    ...(q.status === 'active' ? { status: { in: ACTIVE_EMERGENCY_STATUSES } } : q.status ? { status: q.status } : {}),
    ...(q.priority ? { priority: q.priority } : {}),
    ...(q.departmentId ? { departmentId: q.departmentId } : {}),
  };
  return paginateQuery(prisma.emergencyRequest, { where, include: emergencyInclude, orderBy: [{ createdAt: 'desc' }] }, q, { map: adminView });
}

/**
 * Admin: one emergency. Without a reason: the operational view. With a reason (X-Access-Reason): the clinical details too,
 * only while the emergency is active; the reason is recorded before anything is released. For a closed emergency the
 * clinical record is opened through the patient record instead.
 */
async function getForAdmin(admin, id) {
  const full = await loadFull(id);
  if (!full) throw ApiError.notFound('Emergency not found');
  if (!hasReason(admin)) return adminView(full);
  if (!ACTIVE_EMERGENCY_STATUSES.includes(full.status)) {
    throw ApiError.forbidden('Medical details of a closed emergency are available through the patient record, with a reason.');
  }
  const reason = requireReason(admin);
  const req = currentRequest();
  await auditStrict(req && req.user === admin ? req : { user: admin, headers: {} }, 'MEDICAL_ACCESS_EXCEPTIONAL', 'EmergencyRequest', id,
    { basis: 'ADMIN_REASON', resource: 'EMERGENCY_PATIENT_DETAILS', patientId: full.patient.id, emergencyId: id, reason });
  return { ...full, patient: { ...full.patient, clinicalWithheld: false } };
}

/**
 * Doctor: emergencies they handled, or are alerted to while still active. scope = active | history | all.
 * Closed emergencies stay visible only to the doctor who was assigned; doctors who were merely alerted lose them on closure.
 * Showing an active emergency's patient details is emergency-based (exceptional) access and is audit-logged
 * (once per emergency per doctor per few minutes, so a busy board does not flood the log).
 */
async function listForDoctor(user, scope = 'active') {
  const doctorId = user.profileId;
  const activeInvolved = { status: { in: ACTIVE_EMERGENCY_STATUSES }, OR: [{ assignedDoctorId: doctorId }, { notifications: { some: { doctorId } } }] };
  const closedHandled = { status: { in: ['RESOLVED', 'CANCELLED'] }, assignedDoctorId: doctorId };
  const where = scope === 'history' ? closedHandled : scope === 'all' ? { OR: [activeInvolved, closedHandled] } : activeInvolved;
  const items = await prisma.emergencyRequest.findMany({ where, include: emergencyInclude, orderBy: { createdAt: 'desc' }, take: 100 });
  await auditEmergencyViews(user, items.filter((e) => ACTIVE_EMERGENCY_STATUSES.includes(e.status)));
  return items;
}

/** Writes one MEDICAL_ACCESS_EXCEPTIONAL entry per active emergency shown to the doctor, unless one was written very recently */
async function auditEmergencyViews(user, items) {
  if (!items.length) return;
  const since = new Date(Date.now() - emergencyAuditWindowMinutes * 60000);
  const recent = await prisma.auditLog.findMany({
    where: { userId: user.id, action: 'MEDICAL_ACCESS_EXCEPTIONAL', entityType: 'EmergencyRequest', entityId: { in: items.map((e) => e.id) }, createdAt: { gte: since } },
    select: { entityId: true },
  });
  const seen = new Set(recent.map((r) => r.entityId));
  const fresh = items.filter((e) => !seen.has(e.id));
  if (!fresh.length) return;
  const req = currentRequest();
  await auditStrictMany(req && req.user === user ? req : { user, headers: {} }, fresh.map((e) => ({
    action: 'MEDICAL_ACCESS_EXCEPTIONAL', entityType: 'EmergencyRequest', entityId: e.id,
    details: { basis: e.assignedDoctorId === user.profileId ? 'ACTIVE_EMERGENCY_ASSIGNED' : 'ACTIVE_EMERGENCY_ALERTED', resource: 'EMERGENCY_PATIENT_DETAILS', patientId: e.patient.id, emergencyId: e.id },
  })));
}

/** Patient: their own emergency requests */
const listForPatient = (patientId) => prisma.emergencyRequest.findMany({ where: { patientId }, include: emergencyInclude, orderBy: { createdAt: 'desc' } });

module.exports = {
  listForAdmin, listForDoctor, listForPatient,
  emergencyInclude, adminView, getForAdmin, createEmergency, acceptEmergency, escalateEmergency, escalateEmergencyDetailed, resolveEmergency, cancelEmergency,
  adminUpdate, adminUpdateDetailed, markSeen, loadFull, broadcast,
};
