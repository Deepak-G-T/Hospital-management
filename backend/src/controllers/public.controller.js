const ApiError = require('../utils/ApiError');
const { getDoctorSlots } = require('../services/slot.service');
const { audit } = require('../services/audit.service');
const directory = require('../services/directory.service');
const complaints = require('../services/complaint.service');

exports.stats = async (req, res) => {
  res.json({ success: true, data: await directory.stats() });
};

exports.listDepartments = async (req, res) => {
  res.json({ success: true, data: await directory.listDepartments(req.query.search) });
};

exports.getDepartment = async (req, res) => {
  res.json({ success: true, data: await directory.getDepartment(req.params.id) });
};

exports.listDoctors = async (req, res) => {
  res.json({ success: true, data: await directory.listDoctors(req.query) });
};

exports.getDoctor = async (req, res) => {
  res.json({ success: true, data: await directory.getDoctor(req.params.id) });
};

exports.getDoctorSlots = async (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw ApiError.badRequest('date query parameter (YYYY-MM-DD) is required');
  const data = await getDoctorSlots(req.params.id, date, { excludeAppointmentId: req.query.exclude });
  res.json({ success: true, data });
};

exports.contact = async (req, res) => {
  const complaint = await complaints.createContactMessage(req.body);
  audit(req, 'CONTACT_MESSAGE', 'Complaint', complaint.id, { email: req.body.email });
  res.status(201).json({ success: true, message: 'Thank you! Our team will get back to you shortly.' });
};
