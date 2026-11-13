const { audit } = require('../services/audit.service');
const doctors = require('../services/doctorAdmin.service');

exports.list = async (req, res) => {
  res.json({ success: true, data: await doctors.list(req.query) });
};

exports.get = async (req, res) => {
  res.json({ success: true, data: await doctors.get(req.params.id) });
};

exports.create = async (req, res) => {
  const doctor = await doctors.create(req.body);
  audit(req, 'DOCTOR_CREATED', 'Doctor', doctor.id, { email: req.body.email, fullName: doctor.fullName });
  res.status(201).json({ success: true, data: doctor });
};

exports.update = async (req, res) => {
  const doctor = await doctors.update(req.params.id, req.body);
  audit(req, 'DOCTOR_UPDATED', 'Doctor', doctor.id, { fields: Object.keys(req.body) });
  res.json({ success: true, data: doctor });
};

exports.assignDepartments = async (req, res) => {
  const doctor = await doctors.assignDepartments(req.params.id, req.body);
  audit(req, 'DOCTOR_DEPARTMENTS_ASSIGNED', 'Doctor', doctor.id, { departmentIds: req.body.departmentIds });
  res.json({ success: true, data: doctor });
};

// Deletes the doctor. If they have clinical history, the account is deactivated instead to preserve records.
exports.remove = async (req, res) => {
  const { doctor, hadHistory } = await doctors.remove(req.params.id, req.user);
  audit(req, 'DOCTOR_DELETED', 'Doctor', doctor.id, { fullName: doctor.fullName, soft: true, hadHistory });
  return res.json({ success: true, message: hadHistory ? 'Doctor deleted. Their clinical records are kept and future appointments were cancelled. You can restore the doctor later.' : 'Doctor deleted. You can restore the doctor later.' });
};

exports.restore = async (req, res) => {
  const doctor = await doctors.restore(req.params.id);
  audit(req, 'DOCTOR_RESTORED', 'Doctor', doctor.id, { fullName: doctor.fullName });
  res.json({ success: true, message: 'Doctor restored' });
};
