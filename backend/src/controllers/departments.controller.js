const { audit } = require('../services/audit.service');
const departments = require('../services/department.service');

exports.list = async (req, res) => {
  res.json({ success: true, data: await departments.list(req.query.deleted === 'true') });
};

exports.create = async (req, res) => {
  const dept = await departments.create(req.body);
  audit(req, 'DEPARTMENT_CREATED', 'Department', dept.id, { name: dept.name });
  res.status(201).json({ success: true, data: dept });
};

exports.update = async (req, res) => {
  const dept = await departments.update(req.params.id, req.body);
  audit(req, 'DEPARTMENT_UPDATED', 'Department', dept.id, { fields: Object.keys(req.body) });
  res.json({ success: true, data: dept });
};

exports.remove = async (req, res) => {
  const { dept, hadHistory } = await departments.remove(req.params.id, req.user);
  audit(req, 'DEPARTMENT_DELETED', 'Department', dept.id, { name: dept.name, soft: true, hadHistory });
  return res.json({ success: true, message: hadHistory ? 'Department deleted. Its history is kept; you can restore it later.' : 'Department deleted. You can restore it later.' });
};

exports.restore = async (req, res) => {
  const dept = await departments.restore(req.params.id);
  audit(req, 'DEPARTMENT_RESTORED', 'Department', dept.id, { name: dept.name });
  res.json({ success: true, message: 'Department restored' });
};
