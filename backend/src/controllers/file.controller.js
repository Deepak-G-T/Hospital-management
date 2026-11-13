// Authorised file downloads (never static file serving). Access rules: policies/patientAccess.js
const fs = require('fs');
const { audit } = require('../services/audit.service');
const { streamPrescriptionPdf } = require('../services/pdf.service');
const reports = require('../services/medicalReport.service');
const prescriptions = require('../services/prescription.service');

exports.downloadReport = async (req, res) => {
  const { report, filePath } = await reports.getForDownload(req.user, req.params.id);
  audit(req, 'REPORT_DOWNLOADED', 'MedicalReport', report.id);
  res.setHeader('Content-Type', report.mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${encodeURIComponent(report.fileName)}"`);
  fs.createReadStream(filePath).pipe(res);
};

exports.prescriptionPdf = async (req, res) => {
  const rx = await prescriptions.getForPdf(req.user, req.params.id);
  audit(req, 'PRESCRIPTION_DOWNLOADED', 'Prescription', rx.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${rx.prescriptionNumber}.pdf"`);
  streamPrescriptionPdf(rx, res);
};
