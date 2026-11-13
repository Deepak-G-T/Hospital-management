const { audit } = require('../services/audit.service');
const portal = require('../services/patientPortal.service');
const appointments = require('../services/appointment.service');
const emergencies = require('../services/emergency.service');
const prescriptions = require('../services/prescription.service');
const records = require('../services/medicalRecord.service');
const reports = require('../services/medicalReport.service');

// ── Dashboard ──
exports.dashboard = async (req, res) => {
  res.json({ success: true, data: await portal.dashboard(req.user.profileId, req.user.id) });
};

// ── Profile ──
exports.getProfile = async (req, res) => {
  res.json({ success: true, data: await portal.getProfile(req.user.profileId) });
};

exports.updateProfile = async (req, res) => {
  const patient = await portal.updateProfile(req.user.profileId, req.body);
  audit(req, 'PATIENT_PROFILE_UPDATED', 'Patient', patient.id, { fields: Object.keys(req.body) });
  res.json({ success: true, data: patient });
};

// ── Appointments ──
exports.listAppointments = async (req, res) => {
  res.json({ success: true, data: await appointments.listForPatient(req.user.profileId, req.query) });
};

exports.bookAppointment = async (req, res) => {
  const appt = await appointments.bookAppointment({ ...req.body, patientId: req.user.profileId });
  audit(req, 'APPOINTMENT_BOOKED', 'Appointment', appt.id, { doctorId: appt.doctorId, startAt: appt.startAt });
  res.status(201).json({ success: true, data: appt });
};

exports.cancelAppointment = async (req, res) => {
  const appt = await appointments.changeStatus({ appointmentId: req.params.id, actor: req.user, status: 'CANCELLED', reason: req.body.reason });
  audit(req, 'APPOINTMENT_CANCELLED', 'Appointment', appt.id, { reason: req.body.reason });
  res.json({ success: true, data: appt });
};

exports.rescheduleAppointment = async (req, res) => {
  const appt = await appointments.reschedule({ appointmentId: req.params.id, actor: req.user, startAt: req.body.startAt });
  audit(req, 'APPOINTMENT_RESCHEDULED', 'Appointment', appt.id, { startAt: appt.startAt });
  res.json({ success: true, data: appt });
};

// ── Medical history ──
exports.listRecords = async (req, res) => {
  res.json({ success: true, data: await records.listForPatient(req.user.profileId, req.query.deleted === 'true') });
};

exports.createRecord = async (req, res) => {
  const record = await records.createByPatient(req.user, req.body);
  audit(req, 'MEDICAL_RECORD_ADDED', 'PatientMedicalRecord', record.id);
  res.status(201).json({ success: true, data: record });
};

exports.updateRecord = async (req, res) => {
  const record = await records.updateByPatient(req.user, req.params.id, req.body);
  audit(req, 'MEDICAL_RECORD_UPDATED', 'PatientMedicalRecord', record.id);
  res.json({ success: true, data: record });
};

exports.deleteRecord = async (req, res) => {
  const rec = await records.deleteByPatient(req.user, req.params.id);
  audit(req, 'MEDICAL_RECORD_DELETED', 'PatientMedicalRecord', rec.id);
  res.json({ success: true });
};

// ── Allergies ──
exports.listAllergies = async (req, res) => {
  res.json({ success: true, data: await portal.listAllergies(req.user.profileId, req.query.deleted === 'true') });
};

exports.createAllergy = async (req, res) => {
  const allergy = await portal.createAllergy(req.user.profileId, req.body);
  audit(req, 'ALLERGY_ADDED', 'Allergy', allergy.id, { allergen: allergy.allergen });
  res.status(201).json({ success: true, data: allergy });
};

exports.updateAllergy = async (req, res) => {
  const allergy = await portal.updateAllergy(req.user.profileId, req.params.id, req.body);
  audit(req, 'ALLERGY_UPDATED', 'Allergy', allergy.id);
  res.json({ success: true, data: allergy });
};

exports.deleteAllergy = async (req, res) => {
  await portal.deleteAllergy(req.user, req.params.id);
  audit(req, 'ALLERGY_DELETED', 'Allergy', req.params.id);
  res.json({ success: true });
};

// ── Medical reports ──
exports.listReports = async (req, res) => {
  res.json({ success: true, data: await reports.listForPatient(req.user.profileId, req.query.deleted === 'true', req.query) });
};

exports.uploadReport = async (req, res) => {
  const report = await reports.createByPatient(req.user, req.file, req.body);
  audit(req, 'REPORT_UPLOADED', 'MedicalReport', report.id);
  res.status(201).json({ success: true, data: report });
};

// Restoring something the patient deleted (soft deletion: nothing was ever removed)
exports.restoreRecord = async (req, res) => { const r = await records.restoreByPatient(req.user, req.params.id); audit(req, 'MEDICAL_RECORD_RESTORED', 'PatientMedicalRecord', r.id); res.json({ success: true }); };
exports.restoreAllergy = async (req, res) => { const r = await portal.restoreAllergy(req.user, req.params.id); audit(req, 'ALLERGY_RESTORED', 'Allergy', r.id); res.json({ success: true }); };
exports.restoreReport = async (req, res) => { const r = await reports.restoreByPatient(req.user, req.params.id); audit(req, 'REPORT_RESTORED', 'MedicalReport', r.id); res.json({ success: true }); };

exports.deleteReport = async (req, res) => {
  const report = await reports.deleteByPatient(req.user, req.params.id);
  audit(req, 'REPORT_DELETED', 'MedicalReport', report.id);
  res.json({ success: true });
};

// ── Emergency ──
exports.listEmergencies = async (req, res) => {
  res.json({ success: true, data: await emergencies.listForPatient(req.user.profileId) });
};

exports.createEmergency = async (req, res) => {
  const em = await emergencies.createEmergency(await portal.getPatient(req.user.profileId), req.user, req.body);
  audit(req, 'EMERGENCY_CREATED', 'EmergencyRequest', em.id, { priority: em.priority, locationShared: em.locationConsent });
  res.status(201).json({ success: true, data: em });
};

exports.cancelEmergency = async (req, res) => {
  const em = await emergencies.cancelEmergency(req.params.id, await portal.getPatient(req.user.profileId), req.user);
  audit(req, 'EMERGENCY_CANCELLED', 'EmergencyRequest', em.id);
  res.json({ success: true, data: em });
};

// ── Prescriptions ──
exports.listPrescriptions = async (req, res) => {
  res.json({ success: true, data: await prescriptions.listForPatient(req.user.profileId, req.query) });
};

// ── Reviews ──
exports.listReviews = async (req, res) => {
  res.json({ success: true, data: await portal.listReviews(req.user.profileId, req.query) });
};

exports.createReview = async (req, res) => {
  const review = await portal.createReview(req.user.profileId, req.body);
  audit(req, 'REVIEW_SUBMITTED', 'DoctorReview', review.id, { rating: review.rating });
  res.status(201).json({ success: true, data: review });
};
