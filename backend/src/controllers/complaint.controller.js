const { audit } = require('../services/audit.service');
const complaints = require('../services/complaint.service');

// Complaints submitted by doctors or patients (admins respond via the admin API)
exports.listMine = async (req, res) => {
  res.json({ success: true, data: await complaints.listForUser(req.user.id, req.query) });
};

exports.create = async (req, res) => {
  const complaint = await complaints.create(req.user, req.body);
  audit(req, 'COMPLAINT_SUBMITTED', 'Complaint', complaint.id, { category: complaint.category });
  res.status(201).json({ success: true, data: complaint });
};
