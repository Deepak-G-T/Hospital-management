const ApiError = require('../utils/ApiError');
const { audit, auditStrict, listLogs, activity } = require('../services/audit.service');
const { requireReason } = require('../policies/patientAccess');
const { adminDashboard } = require('../services/analytics.service');
const appointments = require('../services/appointment.service');
const emergencies = require('../services/emergency.service');
const softDelete = require('../services/softDelete.service');
const escalation = require('../services/escalation.service');
const complaints = require('../services/complaint.service');
const users = require('../services/user.service');
const notifications = require('../services/notification.service');
const reports = require('../services/report.service');
const { resolveRange } = require('../utils/dates');

// ── Dashboard & analytics ──
exports.dashboard = async (req, res) => {
  const range = resolveRange(req.query, 30);
  res.json({ success: true, data: await adminDashboard({ ...range, departmentId: req.query.departmentId || null }) });
};

// ── Appointments ──
exports.listAppointments = async (req, res) => {
  res.json({ success: true, data: await appointments.listForAdmin(req.query) });
};

exports.updateAppointmentStatus = async (req, res) => {
  const appt = await appointments.changeStatus({ appointmentId: req.params.id, actor: req.user, ...req.body });
  audit(req, `APPOINTMENT_${req.body.status}`, 'Appointment', appt.id, { reason: req.body.reason });
  res.json({ success: true, data: appointments.adminView(appt) });
};

// ── Emergencies ──
exports.listEmergencies = async (req, res) => {
  res.json({ success: true, data: await emergencies.listForAdmin(req.query) });
};

exports.getEmergency = async (req, res) => {
  const em = await emergencies.getForAdmin(req.user, req.params.id);
  res.json({ success: true, data: em });
};

exports.updateEmergency = async (req, res) => {
  const { emergency: em, priorityChange } = await emergencies.adminUpdateDetailed(req.params.id, req.user, req.body);
  audit(req, 'EMERGENCY_ADMIN_UPDATE', 'EmergencyRequest', em.id, req.body);
  if (priorityChange) audit(req, 'EMERGENCY_PRIORITY_CHANGED', 'EmergencyRequest', em.id, { ...priorityChange, via: 'admin update' });
  res.json({ success: true, data: emergencies.adminView(em) });
};

exports.acknowledgeEmergency = async (req, res) => {
  const result = await escalation.acknowledge(req.user, req.params.id);
  audit(req, 'EMERGENCY_ACKNOWLEDGED', 'EmergencyRequest', req.params.id, { level: result.level, nextEscalationAt: result.nextEscalationAt });
  res.json({ success: true, data: emergencies.adminView(result.emergency) });
};

/** Automatic escalation settings in effect on this API instance (read-only) */
exports.escalationConfig = async (req, res) => {
  res.json({ success: true, data: escalation.describe() });
};

exports.restoreClinical = async (req, res) => {
  const row = await softDelete.restoreAsAdmin(req.params.kind, req.params.id, req.user);
  audit(req, 'MEDICAL_ITEM_RESTORED_BY_ADMIN', 'Patient', row.patientId, { kind: req.params.kind, itemId: row.id });
  res.json({ success: true, message: 'Restored' });
};

exports.resolveEmergency = async (req, res) => {
  const em = await emergencies.resolveEmergency(req.params.id, req.user, req.body.notes);
  audit(req, 'EMERGENCY_RESOLVED', 'EmergencyRequest', em.id);
  res.json({ success: true, data: emergencies.adminView(em) });
};

// ── Complaints ──
exports.listComplaints = async (req, res) => {
  res.json({ success: true, data: await complaints.listForAdmin(req.query) });
};

exports.respondComplaint = async (req, res) => {
  const complaint = await complaints.respond(req.params.id, req.user, req.body);
  audit(req, 'COMPLAINT_RESPONDED', 'Complaint', complaint.id, { status: req.body.status });
  res.json({ success: true, data: complaint });
};

// ── Users ──
exports.listUsers = async (req, res) => {
  res.json({ success: true, data: await users.listUsers(req.query) });
};

exports.setUserStatus = async (req, res) => {
  const user = await users.setActive(req.user.id, req.params.id, req.body.isActive);
  audit(req, user.isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', 'User', user.id, { email: user.email });
  res.json({ success: true, data: user });
};

exports.resetUserPassword = async (req, res) => {
  // Ends every existing session of that user and lifts any failed-login lock on the account
  await users.resetPassword(req.params.id, req.body.newPassword);
  audit(req, 'USER_PASSWORD_RESET', 'User', req.params.id);
  res.json({ success: true, message: 'Password reset successfully' });
};

// ── Activity (doctor & patient activity feed from audit logs) ──
exports.activity = async (req, res) => {
  res.json({ success: true, data: await activity(req.query) });
};

// ── Audit logs ──
exports.auditLogs = async (req, res) => {
  res.json({ success: true, data: await listLogs(req.query) });
};

// ── Notifications management ──
exports.broadcast = async (req, res) => {
  const { audience, title } = req.body;
  const { broadcastId, recipients } = await notifications.broadcast(req.body);
  audit(req, 'NOTIFICATION_BROADCAST', 'Notification', broadcastId, { audience, title, recipients });
  res.status(201).json({ success: true, data: { broadcastId, recipients } });
};

exports.listBroadcasts = async (req, res) => {
  res.json({ success: true, data: await notifications.listBroadcasts() });
};

exports.deleteBroadcast = async (req, res) => {
  const count = await notifications.recallBroadcast(req.params.id);
  audit(req, 'NOTIFICATION_BROADCAST_RECALLED', 'Notification', req.params.id, { removed: count });
  res.json({ success: true, message: `Recalled ${count} notification(s)` });
};

// ── Reports ──
/**
 * Reports (JSON on screen, CSV download). Reports that name patients need a recorded reason (X-Access-Reason) and a date
 * range of at most 366 days. Every delivered report is audited as REPORT_EXPORTED — before it is sent, so if the entry
 * cannot be written the report is not delivered. The audit entry holds metadata only (never report content).
 */
exports.report = async (req, res) => {
  const type = req.params.type;
  const range = resolveRange(req.query, 30);
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const identifying = reports.IDENTIFYING_TYPES.includes(type);
  let reason;
  if (identifying) {
    reason = requireReason(req.user, 'export a report that identifies patients');
    reports.assertExportRange(range);
  }
  const report = await reports.build(type, { ...range, departmentId: req.query.departmentId || null });
  await auditStrict(req, 'REPORT_EXPORTED', 'Report', type, {
    reportType: type, rowCount: report.rows.length, columns: report.columns, from: range.from, to: range.to, format,
    patientIdentifying: identifying, ...(reason ? { reason } : {}),
  });
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${type}-report-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(reports.toCsv(report));
  }
  return res.json({ success: true, data: { type, ...range, ...report, total: report.rows.length } });
};
