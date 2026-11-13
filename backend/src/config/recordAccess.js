// Settings for access to patient medical information (see policies/patientAccess.js).
//
//   RECORD_ACCESS_GRACE_HOURS   How long after an appointment ends it still counts as an ACTIVE treatment relationship
//                               (default 48). It covers documenting the visit (prescription, report, referral) even if the
//                               doctor marks the appointment completed early or forgets to. Afterwards the doctor keeps
//                               access only to the records tied to that consultation.
const hours = Number(process.env.RECORD_ACCESS_GRACE_HOURS);

module.exports = {
  graceHours: Number.isFinite(hours) && hours >= 0 ? hours : 48,
  /** An administrator must give a reason (recorded in the audit log) before opening clinical details */
  reasonMin: 10,
  reasonMax: 500,
  /** Doctors' emergency-board views of patient data are audit-logged at most once per emergency per this many minutes */
  emergencyAuditWindowMinutes: 15,
};
