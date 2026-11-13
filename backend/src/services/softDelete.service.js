// Soft deletion of clinical items and restoration. A "deleted" row is never removed: deleted_at / deleted_by_user_id are set,
// ordinary views hide it, and treating clinicians still see it flagged as removed by the patient (so a removed allergy never
// disappears from a safety view). Report files stay on disk. Audit logs are never deleted.
const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { requireReason } = require('../policies/patientAccess');
const { auditStrict } = require('./audit.service');
const { currentRequest } = require('../utils/requestContext');

const MODELS = { records: 'patientMedicalRecord', allergies: 'allergy', reports: 'medicalReport' };
const KINDS = Object.keys(MODELS);
const marker = (actor) => ({ deletedAt: new Date(), deletedByUserId: actor.id });
const cleared = { deletedAt: null, deletedByUserId: null };

/** Marks the row deleted (idempotent guard: only a live row can be deleted). Returns the number of rows changed. */
async function markDeleted(kind, where, actor) {
  return (await prisma[MODELS[kind]].updateMany({ where: { ...where, deletedAt: null }, data: marker(actor) })).count;
}

/** The patient restores something they deleted. */
async function restoreOwn(kind, id, actor) {
  const row = await prisma[MODELS[kind]].findFirst({ where: { id, patientId: actor.profileId, deletedAt: { not: null } } });
  if (!row) throw ApiError.notFound('Nothing to restore');
  await prisma[MODELS[kind]].update({ where: { id }, data: cleared });
  return row;
}

/**
 * An administrator restores a patient's deleted item (for example at the patient's request). Clinical data, so a recorded
 * reason is required and the audit entry is written first; if it cannot be written, nothing is restored.
 */
async function restoreAsAdmin(kind, id, admin) {
  const reason = requireReason(admin, 'restore a patient\'s deleted medical information');
  const row = await prisma[MODELS[kind]].findFirst({ where: { id, deletedAt: { not: null } } });
  if (!row) throw ApiError.notFound('Nothing to restore');
  const req = currentRequest();
  await auditStrict(req && req.user === admin ? req : { user: admin, headers: {} }, 'MEDICAL_ITEM_RESTORED', 'Patient', row.patientId, { kind, itemId: id, reason });
  await prisma[MODELS[kind]].update({ where: { id }, data: cleared });
  return row;
}

module.exports = { KINDS, markDeleted, restoreOwn, restoreAsAdmin, marker, cleared };
