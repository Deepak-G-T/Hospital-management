// Uploaded medical reports (lab results, scans, consultation reports). Files live in REPORT_DIR under random names
// and are only ever served through an authorised download.
const fs = require('fs');
const path = require('path');
const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { notifyUser } = require('./notification.service');
const { authorizeWrite, authorizeItem } = require('../policies/patientAccess');
const { REPORT_DIR } = require('../middleware/upload');
const { nameOnly } = require('../db/selects');
const { markDeleted, restoreOwn } = require('./softDelete.service');
const { paginateQuery } = require('../utils/pagination');

const fileFields = (file) => ({ fileName: file.originalname.slice(0, 255), storedName: file.filename, mimeType: file.mimetype, fileSize: file.size });

const listForPatient = (patientId, deleted = false, query = {}) => paginateQuery(prisma.medicalReport, {
  where: { patientId, deletedAt: deleted ? { not: null } : null }, orderBy: { createdAt: 'desc' }, include: { doctor: nameOnly, uploadedBy: { select: { role: true } } },
}, query);

/** The patient uploads a report to their own record */
const createByPatient = (actor, file, { title, reportType, notes }) => prisma.medicalReport.create({
  data: { patientId: actor.profileId, uploadedByUserId: actor.id, title, reportType, notes: notes || null, ...fileFields(file) },
});

/** A doctor with an active treatment relationship (or one linked to their own appointment) uploads a report; the patient is notified. The file is removed if access is refused. */
async function createByDoctor(actor, patientId, file, { title, reportType, notes, appointmentId }) {
  try {
    await authorizeWrite(actor, patientId, { appointmentId }, 'REPORT_UPLOAD');
  } catch (e) {
    fs.unlink(file.path, () => {});
    throw e;
  }
  const report = await prisma.medicalReport.create({
    data: { patientId, doctorId: actor.profileId, uploadedByUserId: actor.id, appointmentId: appointmentId || null, title, reportType, notes: notes || null, ...fileFields(file) },
  });
  const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { userId: true } });
  await notifyUser(patient.userId, { type: 'REPORT', title: 'New consultation report', message: `Dr. ${actor.fullName} uploaded "${report.title}".`, link: '/patient/reports' });
  return report;
}

/** The patient deletes a report they uploaded themselves (doctors' reports stay). Soft delete: the file is kept on disk. */
async function deleteByPatient(actor, id) {
  const report = await prisma.medicalReport.findUnique({ where: { id } });
  if (!report || report.patientId !== actor.profileId || report.deletedAt) throw ApiError.notFound('Report not found');
  if (report.uploadedByUserId !== actor.id) throw ApiError.forbidden('Reports uploaded by your doctor cannot be deleted');
  if (!(await markDeleted('reports', { id: report.id }, actor))) throw ApiError.notFound('Report not found');
  return report;
}
const restoreByPatient = (actor, id) => restoreOwn('reports', id, actor);

/** For a download: the report row and its file path, after the access check */
async function getForDownload(user, id) {
  const report = await prisma.medicalReport.findUnique({ where: { id } });
  // a report the patient deleted is gone for the patient and for admins; treating clinicians keep their access
  if (!report || (report.deletedAt && user.role !== 'DOCTOR')) throw ApiError.notFound('Report not found');
  await authorizeItem(user, { kind: 'REPORT', id: report.id, patientId: report.patientId, appointmentId: report.appointmentId, doctorId: report.doctorId });
  const filePath = path.join(REPORT_DIR, path.basename(report.storedName));
  if (!fs.existsSync(filePath)) throw ApiError.notFound('File is missing from storage');
  return { report, filePath };
}

module.exports = { listForPatient, createByPatient, createByDoctor, deleteByPatient, restoreByPatient, getForDownload };
