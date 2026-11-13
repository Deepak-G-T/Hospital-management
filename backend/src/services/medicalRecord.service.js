// Medical history entries (conditions, diagnoses, surgeries…), written by patients or by their doctors.
const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { notifyUser } = require('./notification.service');
const { authorizeWrite } = require('../policies/patientAccess');
const { recordAuthor } = require('../db/selects');
const { markDeleted, restoreOwn } = require('./softDelete.service');

const toDate = (d) => (d ? new Date(d) : null);

/** The patient's history; `deleted` = the entries they deleted (for restoring) */
const listForPatient = (patientId, deleted = false) => prisma.patientMedicalRecord.findMany({
  where: { patientId, deletedAt: deleted ? { not: null } : null }, orderBy: { createdAt: 'desc' }, include: { createdBy: recordAuthor },
});

/** The patient adds to their own history */
const createByPatient = (actor, data) => prisma.patientMedicalRecord.create({
  data: { ...data, diagnosedOn: toDate(data.diagnosedOn), patientId: actor.profileId, createdByUserId: actor.id },
});

/** A patient may only change entries they wrote themselves */
async function ownEntry(actor, id, verb) {
  const rec = await prisma.patientMedicalRecord.findUnique({ where: { id } });
  if (!rec || rec.patientId !== actor.profileId || rec.deletedAt) throw ApiError.notFound('Record not found');
  if (rec.createdByUserId !== actor.id) throw ApiError.forbidden(verb === 'delete' ? 'Records added by a doctor cannot be deleted by the patient' : 'Records added by a doctor can only be changed by the doctor');
  return rec;
}

async function updateByPatient(actor, id, data) {
  const rec = await ownEntry(actor, id, 'update');
  return prisma.patientMedicalRecord.update({ where: { id: rec.id }, data: { ...data, diagnosedOn: toDate(data.diagnosedOn) } });
}

async function deleteByPatient(actor, id) {
  const rec = await ownEntry(actor, id, 'delete');
  if (!(await markDeleted('records', { id: rec.id }, actor))) throw ApiError.notFound('Record not found'); // soft delete: the row is kept
  return rec;
}
const restoreByPatient = (actor, id) => restoreOwn('records', id, actor);

/** A doctor with an active treatment relationship (or one linked to their own appointment) adds to the patient's history; the patient is notified */
async function createByDoctor(actor, patientId, data) {
  await authorizeWrite(actor, patientId, { appointmentId: data.appointmentId }, 'MEDICAL_RECORD_WRITE');
  const record = await prisma.patientMedicalRecord.create({
    data: { ...data, diagnosedOn: toDate(data.diagnosedOn), patientId, createdByUserId: actor.id },
  });
  const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { userId: true } });
  await notifyUser(patient.userId, { type: 'REPORT', title: 'Medical history updated', message: `Dr. ${actor.fullName} added "${record.title}" to your medical history.`, link: '/patient/medical-profile' });
  return record;
}

module.exports = { listForPatient, createByPatient, updateByPatient, deleteByPatient, restoreByPatient, createByDoctor };
