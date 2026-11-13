// Patient accounts managed by the admin: list, view (full record), register, edit.
const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { hashPassword } = require('./password.service');
const { nameOnly, departmentName } = require('../db/selects');
const { paginateQuery } = require('../utils/pagination');
const { authorizeChart, hasReason } = require('../policies/patientAccess');

// Registration and contact data an administrator needs to manage accounts. Clinical fields (blood group, height, weight,
// allergies, history, diagnoses) are NOT in this selection: they appear only in the reason-gated detail view.
const registrationFields = {
  id: true, userId: true, fullName: true, phone: true, dateOfBirth: true, gender: true, address: true,
  emergencyContactName: true, emergencyContactPhone: true, createdAt: true, updatedAt: true,
  user: { select: { id: true, email: true, isActive: true, lastLoginAt: true } },
  _count: { select: { appointments: true, emergencyRequests: true } },
};
const clinicalFields = { bloodGroup: true, heightCm: true, weightKg: true };

async function list({ search, status, ...rest }) {
  const where = {
    ...(status === 'active' ? { user: { isActive: true } } : status === 'inactive' ? { user: { isActive: false } } : {}),
    ...(search ? {
      OR: [
        { fullName: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ],
    } : {}),
  };
  return paginateQuery(prisma.patient, { where, select: registrationFields, orderBy: { createdAt: 'desc' } }, rest);
}

/**
 * One patient. Registration and operational data (profile, appointments, emergency requests) need no reason. The clinical
 * parts (allergies, medical history) are returned only when the admin gives a reason (X-Access-Reason header); the
 * reason and what was opened are recorded in the audit log before the data is released.
 */
async function get(id, admin) {
  const clinical = hasReason(admin);
  if (clinical) {
    const exists = await prisma.patient.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw ApiError.notFound('Patient not found');
    await authorizeChart(admin, id, 'ADMIN_PATIENT_RECORD');
  }
  const patient = await prisma.patient.findUnique({
    where: { id },
    select: {
      ...registrationFields,
      ...(clinical ? { ...clinicalFields, allergies: { where: { deletedAt: null } }, medicalRecords: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' } } } : {}),
      // scheduling data only: no diagnosis, treatment or notes
      appointments: { orderBy: { startAt: 'desc' }, take: 20, select: { id: true, startAt: true, endAt: true, status: true, type: true, reason: true, doctor: nameOnly, department: departmentName } },
      // without a reason only the operational summary of past emergencies (no symptoms or description)
      emergencyRequests: clinical
        ? { orderBy: { createdAt: 'desc' }, take: 10 }
        : { orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, priority: true, status: true, createdAt: true, resolvedAt: true } },
    },
  });
  if (!patient) throw ApiError.notFound('Patient not found');
  return { ...patient, allergies: patient.allergies || [], medicalRecords: patient.medicalRecords || [], clinicalWithheld: !clinical };
}

/** Registration: the admin may enter blood group here. It is stored, but never returned by this endpoint. */
async function create({ email, password, dateOfBirth, ...profile }) {
  const passwordHash = await hashPassword(password);
  return prisma.$transaction(async (tx) => {
    if (await tx.user.findUnique({ where: { email } })) throw ApiError.conflict('An account with this email already exists');
    const user = await tx.user.create({ data: { email, passwordHash, role: 'PATIENT' } });
    return tx.patient.create({ data: { ...profile, dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null, userId: user.id }, select: registrationFields });
  });
}

// Fields an administrator may change on an existing patient. Blood group is entered at registration only; clinical data
// is never edited here.
const EDITABLE = ['fullName', 'phone', 'gender', 'address', 'emergencyContactName', 'emergencyContactPhone'];
const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const sameDate = (a, b) => (a ? new Date(a).toISOString().slice(0, 10) : null) === (b || null);

/**
 * Updates ONLY the fields that were sent with a real value AND differ from what is stored. A blank or missing value never
 * overwrites existing data (the admin form used to send every field, blank ones included, which erased them).
 * Returns the registration view; writes nothing when nothing changed.
 */
async function update(id, input) {
  const existing = await prisma.patient.findUnique({ where: { id }, include: { user: { select: { email: true } } } });
  if (!existing) throw ApiError.notFound('Patient not found');
  const data = {};
  for (const k of EDITABLE) if (!blank(input[k]) && input[k] !== existing[k]) data[k] = input[k];
  if (!blank(input.dateOfBirth) && !sameDate(existing.dateOfBirth, input.dateOfBirth)) data.dateOfBirth = new Date(input.dateOfBirth);
  const emailChanged = !blank(input.email) && input.email !== existing.user.email;
  if (!emailChanged && !Object.keys(data).length) return prisma.patient.findUnique({ where: { id }, select: registrationFields });
  return prisma.$transaction(async (tx) => {
    if (emailChanged) await tx.user.update({ where: { id: existing.userId }, data: { email: input.email } });
    return tx.patient.update({ where: { id: existing.id }, data, select: registrationFields });
  });
}

module.exports = { list, get, create, update };
