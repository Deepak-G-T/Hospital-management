const { audit } = require('../services/audit.service');
const { doctorDashboard } = require('../services/analytics.service');
const portal = require('../services/doctorPortal.service');
const appointments = require('../services/appointment.service');
const emergencies = require('../services/emergency.service');
const escalation = require('../services/escalation.service');
const prescriptions = require('../services/prescription.service');
const records = require('../services/medicalRecord.service');
const reports = require('../services/medicalReport.service');
const { resolveRange } = require('../utils/dates');

// ── Dashboard ──
exports.dashboard = async (req, res) => {
  res.json({ success: true, data: await doctorDashboard(req.user.profileId, resolveRange(req.query, 30)) });
};

// ── Profile ──
exports.getProfile = async (req, res) => {
  res.json({ success: true, data: await portal.getProfile(req.user.profileId) });
};

exports.updateProfile = async (req, res) => {
  const doctor = await portal.updateProfile(req.user.profileId, req.body);
  audit(req, 'DOCTOR_PROFILE_UPDATED', 'Doctor', doctor.id, { fields: Object.keys(req.body) });
  res.json({ success: true, data: doctor });
};

// ── Availability ──
exports.getAvailability = async (req, res) => {
  res.json({ success: true, data: await portal.getAvailability(req.user.profileId) });
};

exports.setAvailability = async (req, res) => {
  const slots = await portal.setAvailability(req.user.profileId, req.body.slots);
  audit(req, 'AVAILABILITY_UPDATED', 'Doctor', req.user.profileId, { blocks: slots.length });
  res.json({ success: true, data: slots });
};

// ── Appointments ──
exports.listAppointments = async (req, res) => {
  res.json({ success: true, data: await appointments.listForDoctor(req.user.profileId, req.query) });
};

exports.updateAppointmentStatus = async (req, res) => {
  const appt = await appointments.changeStatus({ appointmentId: req.params.id, actor: req.user, ...req.body });
  audit(req, `APPOINTMENT_${req.body.status}`, 'Appointment', appt.id, { reason: req.body.reason });
  res.json({ success: true, data: appt });
};

exports.saveConsultation = async (req, res) => {
  const updated = await portal.saveConsultation(req.user, req.params.id, req.body);
  audit(req, 'CONSULTATION_SAVED', 'Appointment', updated.id);
  res.json({ success: true, data: updated });
};

// ── Patients ──
exports.listPatients = async (req, res) => {
  res.json({ success: true, data: await portal.listPatients(req.user.profileId, { search: req.query.search, treating: req.query.treating === 'true', page: req.query.page, limit: req.query.limit }) });
};

exports.getPatient = async (req, res) => {
  const patient = await portal.getPatientRecord(req.user, req.params.id);
  audit(req, 'PATIENT_RECORD_VIEWED', 'Patient', patient.id, { level: patient.access.level });
  res.json({ success: true, data: patient });
};

exports.addPatientRecord = async (req, res) => {
  const record = await records.createByDoctor(req.user, req.params.id, req.body);
  audit(req, 'MEDICAL_RECORD_ADDED', 'PatientMedicalRecord', record.id, { patientId: req.params.id });
  res.status(201).json({ success: true, data: record });
};

exports.uploadPatientReport = async (req, res) => {
  const report = await reports.createByDoctor(req.user, req.params.id, req.file, req.body);
  audit(req, 'REPORT_UPLOADED', 'MedicalReport', report.id, { patientId: req.params.id });
  res.status(201).json({ success: true, data: report });
};

// ── Prescriptions ──
exports.createPrescription = async (req, res) => {
  const rx = await prescriptions.create(req.user, req.body);
  audit(req, 'PRESCRIPTION_CREATED', 'Prescription', rx.id, { patientId: req.body.patientId });
  res.status(201).json({ success: true, data: rx });
};

exports.listPrescriptions = async (req, res) => {
  res.json({ success: true, data: await prescriptions.listForDoctor(req.user.profileId, req.query) });
};

// ── Emergencies ──
exports.listEmergencies = async (req, res) => {
  res.json({ success: true, data: await emergencies.listForDoctor(req.user, req.query.scope || 'active') });
};

exports.markEmergencySeen = async (req, res) => {
  await emergencies.markSeen(req.params.id, req.user.profileId);
  res.json({ success: true });
};

exports.acceptEmergency = async (req, res) => {
  const em = await emergencies.acceptEmergency(req.params.id, await portal.getDoctor(req.user.profileId), req.user, req.body.note);
  audit(req, 'EMERGENCY_ACCEPTED', 'EmergencyRequest', em.id);
  res.json({ success: true, data: em });
};

exports.escalateEmergency = async (req, res) => {
  const { emergency: em, priorityChange } = await emergencies.escalateEmergencyDetailed(req.params.id, await portal.getDoctor(req.user.profileId), req.user, req.body.reason);
  // the doctor's clinical reason is kept on the emergency timeline (authorised view); the audit log records only that one was given
  audit(req, 'EMERGENCY_ESCALATED', 'EmergencyRequest', em.id, { reasonGiven: true, priorityFrom: priorityChange.from, priorityTo: priorityChange.to });
  if (priorityChange.from !== priorityChange.to) audit(req, 'EMERGENCY_PRIORITY_CHANGED', 'EmergencyRequest', em.id, { ...priorityChange, via: 'doctor escalation' });
  res.json({ success: true, data: em });
};

/** "Seen — assessing": not acceptance; pauses the next automatic escalation for one target interval */
exports.acknowledgeEmergency = async (req, res) => {
  const result = await escalation.acknowledge(req.user, req.params.id);
  audit(req, 'EMERGENCY_ACKNOWLEDGED', 'EmergencyRequest', req.params.id, { level: result.level, nextEscalationAt: result.nextEscalationAt });
  res.json({ success: true, data: result.emergency });
};

exports.resolveEmergency = async (req, res) => {
  const em = await emergencies.resolveEmergency(req.params.id, req.user, req.body.notes);
  audit(req, 'EMERGENCY_RESOLVED', 'EmergencyRequest', em.id);
  res.json({ success: true, data: em });
};

// ── Referrals ──
exports.colleagues = async (req, res) => {
  res.json({ success: true, data: await portal.colleagues(req.user.profileId) });
};

exports.createReferral = async (req, res) => {
  const referral = await portal.createReferral(req.user, req.body);
  audit(req, 'REFERRAL_CREATED', 'Referral', referral.id, { toDoctorId: req.body.toDoctorId, patientId: req.body.patientId });
  res.status(201).json({ success: true, data: referral });
};

exports.listReferrals = async (req, res) => {
  res.json({ success: true, data: await portal.listReferrals(req.user.profileId) });
};

exports.updateReferral = async (req, res) => {
  const updated = await portal.updateReferral(req.user, req.params.id, req.body.status);
  audit(req, 'REFERRAL_UPDATED', 'Referral', updated.id, { status: req.body.status });
  res.json({ success: true, data: updated });
};

// ── Inter-department communication ──
exports.listMessages = async (req, res) => {
  res.json({ success: true, data: await portal.listMessages(req.user.profileId) });
};

exports.sendMessage = async (req, res) => {
  const { message, toDepartmentId } = await portal.sendMessage(req.user.profileId, req.body);
  audit(req, 'DEPARTMENT_MESSAGE_SENT', 'DepartmentMessage', message.id, { toDepartmentId });
  res.status(201).json({ success: true, data: message });
};

// ── Feedback ──
exports.listReviews = async (req, res) => {
  res.json({ success: true, data: await portal.listReviews(req.user.profileId, req.query) });
};
