const { audit } = require('../services/audit.service');
const patients = require('../services/patientAdmin.service');

exports.list = async (req, res) => {
  res.json({ success: true, data: await patients.list(req.query) });
};

exports.get = async (req, res) => {
  const patient = await patients.get(req.params.id, req.user);
  audit(req, 'PATIENT_RECORD_VIEWED', 'Patient', patient.id, { clinical: !patient.clinicalWithheld });
  res.json({ success: true, data: patient });
};

exports.create = async (req, res) => {
  const patient = await patients.create(req.body);
  audit(req, 'PATIENT_CREATED', 'Patient', patient.id, { email: req.body.email });
  res.status(201).json({ success: true, data: patient });
};

exports.update = async (req, res) => {
  const patient = await patients.update(req.params.id, req.body);
  audit(req, 'PATIENT_UPDATED', 'Patient', patient.id, { fields: Object.keys(req.body) });
  res.json({ success: true, data: patient });
};
