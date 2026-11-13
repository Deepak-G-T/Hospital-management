// Who may see (or add to) a patient's clinical data — one definition for every endpoint that reads, lists, writes or
// downloads medical information (chart, history, allergies, prescriptions, reports, PDFs and file downloads).
//
// PATIENT  only their own data.
//
// DOCTOR   access comes from a care relationship, and its kind decides how much is visible:
//   TREATMENT   a confirmed appointment (or one completed/ended within RECORD_ACCESS_GRACE_HOURS), or an accepted
//               referral to the doctor → allergies, medical history, prescriptions and reports, the doctor's own
//               appointments, and the emergencies they were involved in. May add records, reports, prescriptions, referrals.
//   EMERGENCY   the doctor accepted an emergency that is still active → allergies, medical history and prescriptions
//               ("necessary records"; no reports, no appointment history). May document and prescribe.
//               This is EXCEPTIONAL access and is always audit-logged.
//   HISTORICAL  completed consultations, closed emergencies the doctor handled, completed referrals → only the records
//               tied to those consultations (written by the doctor, or linked to their appointment). Nothing else.
//   NONE        rejected, cancelled, no-show or pending appointments, declined/pending referrals, emergencies the doctor
//               was only alerted to (the alert itself shows the emergency's own details while it is active), and
//               everything about unrelated patients.
//
// ADMIN    operational data (names, appointments, emergency monitoring) needs no reason. Clinical details need a reason
//          (header X-Access-Reason, 10–500 characters) that is recorded in the audit log together with what was opened.
//
// Exceptional access (admin with a reason, emergency-based doctor access) is written to the audit log BEFORE the data is
// released; if the entry cannot be written, access is refused. Refused doctor attempts are logged too. Because the audit
// call lives here, an endpoint that uses this policy cannot forget it.
const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { graceHours, reasonMin, reasonMax } = require('../config/recordAccess');
const { ACTIVE_EMERGENCY_STATUSES } = require('../utils/constants');
const { currentRequest } = require('../utils/requestContext');
const { audit, auditStrict } = require('../services/audit.service');

const LEVELS = Object.freeze({ TREATMENT: 'TREATMENT', EMERGENCY: 'EMERGENCY', HISTORICAL: 'HISTORICAL', NONE: 'NONE' });
const MS_HOUR = 3600 * 1000;

/** Prisma `where` (on Patient): patients the doctor has any chart-level relationship with (TREATMENT, EMERGENCY or HISTORICAL) */
const careRelationshipWhere = (doctorId) => ({
  OR: [
    { appointments: { some: { doctorId, status: { in: ['CONFIRMED', 'COMPLETED'] } } } },
    { emergencyRequests: { some: { assignedDoctorId: doctorId } } },
    { referrals: { some: { toDoctorId: doctorId, status: { in: ['ACCEPTED', 'COMPLETED'] } } } },
  ],
});

/**
 * Works out what the doctor may see of this patient. Pure read; no audit, no throwing.
 * Returns { level, bases, sections, appointmentIds, canWrite, exceptional }.
 */
async function doctorAccess(doctorId, patientId, now = new Date()) {
  const [appointments, emergencies, referrals] = await Promise.all([
    prisma.appointment.findMany({ where: { doctorId, patientId, status: { in: ['CONFIRMED', 'COMPLETED'] } }, select: { id: true, endAt: true } }),
    prisma.emergencyRequest.findMany({ where: { patientId, assignedDoctorId: doctorId }, select: { id: true, status: true } }),
    prisma.referral.findMany({ where: { patientId, toDoctorId: doctorId, status: { in: ['ACCEPTED', 'COMPLETED'] } }, select: { id: true, status: true } }),
  ]);
  const activeFrom = new Date(now.getTime() - graceHours * MS_HOUR);
  const bases = new Set();
  for (const a of appointments) bases.add(a.endAt > activeFrom ? 'ACTIVE_APPOINTMENT' : 'PAST_APPOINTMENT');
  for (const e of emergencies) bases.add(ACTIVE_EMERGENCY_STATUSES.includes(e.status) ? 'ACTIVE_EMERGENCY' : 'CLOSED_EMERGENCY');
  for (const r of referrals) bases.add(r.status === 'ACCEPTED' ? 'ACCEPTED_REFERRAL' : 'PAST_REFERRAL');

  const treatment = bases.has('ACTIVE_APPOINTMENT') || bases.has('ACCEPTED_REFERRAL');
  const emergency = bases.has('ACTIVE_EMERGENCY');
  const past = ['PAST_APPOINTMENT', 'CLOSED_EMERGENCY', 'PAST_REFERRAL'].some((b) => bases.has(b));
  const level = treatment ? LEVELS.TREATMENT : emergency ? LEVELS.EMERGENCY : past ? LEVELS.HISTORICAL : LEVELS.NONE;
  const broad = treatment || emergency;
  return {
    level,
    bases: [...bases],
    // 'all' = everything of that kind, 'linked' = only records tied to the doctor's own consultations, false = nothing
    sections: {
      allergies: broad,
      history: broad ? 'all' : past ? 'linked' : false,
      prescriptions: broad ? 'all' : past ? 'linked' : false,
      reports: treatment ? 'all' : past ? 'linked' : false,
    },
    appointmentIds: appointments.map((a) => a.id),
    canWrite: treatment || emergency,
    // Chart access that rests on an emergency alone is break-glass style access
    exceptional: emergency && !treatment,
  };
}

/**
 * The ids of patients for whom the doctor has TREATMENT or EMERGENCY access (the levels that may see allergies and blood
 * group), in three queries instead of one per patient. Must agree with doctorAccess(): architecture.test.js checks it.
 */
async function treatmentPatientIds(doctorId, now = new Date()) {
  const activeFrom = new Date(now.getTime() - graceHours * MS_HOUR);
  const [appointments, referrals, emergencies] = await Promise.all([
    prisma.appointment.findMany({ where: { doctorId, status: { in: ['CONFIRMED', 'COMPLETED'] }, endAt: { gt: activeFrom } }, select: { patientId: true } }),
    prisma.referral.findMany({ where: { toDoctorId: doctorId, status: 'ACCEPTED' }, select: { patientId: true } }),
    prisma.emergencyRequest.findMany({ where: { assignedDoctorId: doctorId, status: { in: ACTIVE_EMERGENCY_STATUSES } }, select: { patientId: true } }),
  ]);
  return new Set([...appointments, ...referrals, ...emergencies].map((r) => r.patientId));
}

/** What the client may be told about its own access (additive field on the chart response) */
const summary = (a) => ({ level: a.level, bases: a.bases, canWrite: a.canWrite, sections: a.sections });

// ── Auditing ──
const auditCtx = (user) => {
  const req = currentRequest();
  return req && req.user === user ? req : { user, ip: req?.ip, headers: req?.headers || {}, socket: req?.socket };
};

async function recordExceptional(user, basis, resource, patientId, extra = {}) {
  await auditStrict(auditCtx(user), 'MEDICAL_ACCESS_EXCEPTIONAL', 'Patient', patientId, { basis, resource, patientId, ...extra });
}
const recordDenied = (user, resource, patientId, extra = {}) => audit(auditCtx(user), 'MEDICAL_ACCESS_DENIED', 'Patient', patientId, { resource, patientId, ...extra });

// ── Admin reason ──
const cleanReason = (raw) => String(raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** True when the request carries a reason header at all (valid or not) */
const hasReason = (user) => user?.accessReason !== undefined;

/** The validated reason, or a 400 with details.code = REASON_REQUIRED */
function requireReason(user, purpose = 'open medical details') {
  const reason = cleanReason(user?.accessReason);
  if (reason.length < reasonMin || reason.length > reasonMax) {
    throw ApiError.badRequest(`A reason of ${reasonMin}–${reasonMax} characters is required to ${purpose}. It is recorded in the audit log.`, { code: 'REASON_REQUIRED', minLength: reasonMin, maxLength: reasonMax });
  }
  return reason;
}

// ── Reading ──
/**
 * Authorises reading a patient's clinical data as a whole (chart). Returns a decision:
 *   { role, level, sections, appointmentIds, canWrite, bases, reason? }
 * Throws 403 (and logs the attempt) for a doctor without a relationship, 400 for an admin without a reason.
 * `resource` names what is being opened, for the audit log.
 */
async function authorizeChart(user, patientId, resource = 'PATIENT_CHART', extra = {}) {
  if (user.role === 'PATIENT') {
    if (user.profileId !== patientId) throw ApiError.forbidden();
    return { role: 'PATIENT', level: 'SELF', bases: ['SELF'], sections: { allergies: true, history: 'all', prescriptions: 'all', reports: 'all' }, appointmentIds: [], canWrite: false };
  }
  if (user.role === 'ADMIN') {
    const reason = requireReason(user);
    await recordExceptional(user, 'ADMIN_REASON', resource, patientId, { reason, ...extra });
    return { role: 'ADMIN', level: 'ADMIN', bases: ['ADMIN_REASON'], sections: { allergies: true, history: 'all', prescriptions: 'all', reports: 'all' }, appointmentIds: [], canWrite: false, reason };
  }
  if (user.role !== 'DOCTOR') throw ApiError.forbidden();
  const access = await doctorAccess(user.profileId, patientId);
  if (access.level === LEVELS.NONE) {
    await recordDenied(user, resource, patientId, extra);
    throw ApiError.forbidden('You do not have access to this patient\'s medical information');
  }
  if (access.exceptional) await recordExceptional(user, access.bases.join('+'), resource, patientId, { sections: access.sections, ...extra });
  return { role: 'DOCTOR', ...access };
}

const SECTION_OF = { REPORT: 'reports', PRESCRIPTION: 'prescriptions', HISTORY_RECORD: 'history' };

/**
 * Authorises reading ONE clinical item (report file, prescription PDF, history entry).
 * item: { kind: 'REPORT'|'PRESCRIPTION'|'HISTORY_RECORD', id, patientId, appointmentId?, doctorId?, createdByUserId? }
 * Doctors always keep access to what they wrote or issued themselves; otherwise the same section rules as the chart apply.
 */
async function authorizeItem(user, item) {
  const resource = `${item.kind}_${item.kind === 'REPORT' ? 'DOWNLOAD' : item.kind === 'PRESCRIPTION' ? 'PDF' : 'VIEW'}`;
  const extra = { itemId: item.id };
  if (user.role !== 'DOCTOR') return authorizeChart(user, item.patientId, resource, extra);

  const authored = (item.doctorId && item.doctorId === user.profileId) || (item.createdByUserId && item.createdByUserId === user.id);
  if (authored) return { role: 'DOCTOR', level: 'AUTHOR', bases: ['AUTHOR'], sections: {}, appointmentIds: [], canWrite: false };
  const access = await doctorAccess(user.profileId, item.patientId);
  const section = access.sections[SECTION_OF[item.kind]];
  const linked = item.appointmentId && access.appointmentIds.includes(item.appointmentId);
  if (!(section === 'all' || (section === 'linked' && linked))) {
    await recordDenied(user, resource, item.patientId, { ...extra, level: access.level });
    throw ApiError.forbidden('You do not have access to this patient\'s medical information');
  }
  if (access.exceptional) await recordExceptional(user, access.bases.join('+'), resource, item.patientId, extra);
  return { role: 'DOCTOR', ...access };
}

// ── Writing ──
/**
 * Authorises adding clinical data for a patient (history entry, report, prescription, referral).
 * Needs TREATMENT or EMERGENCY access — or an explicit link to one of the doctor's own confirmed/completed appointments
 * with this patient, which lets a doctor document an earlier consultation.
 */
async function authorizeWrite(user, patientId, { appointmentId } = {}, resource = 'CLINICAL_WRITE') {
  if (user.role !== 'DOCTOR') throw ApiError.forbidden();
  const access = await doctorAccess(user.profileId, patientId);
  const linked = appointmentId && access.appointmentIds.includes(appointmentId);
  if (!(access.canWrite || linked)) {
    await recordDenied(user, resource, patientId, { level: access.level });
    throw ApiError.forbidden('You do not have an active treatment relationship with this patient');
  }
  if (appointmentId && !linked) throw ApiError.badRequest('Invalid appointment for this patient');
  return access;
}

// Kept for callers that only need "may this signed-in user see the patient's data?"
const assertCanAccessPatientData = (user, patientId, resource) => authorizeChart(user, patientId, resource);

module.exports = {
  LEVELS, careRelationshipWhere, doctorAccess, treatmentPatientIds, summary, hasReason, requireReason,
  authorizeChart, authorizeItem, authorizeWrite, assertCanAccessPatientData,
};
