// Departments (admin management). Public listings live in directory.service.js.
const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { idAndName, doctorBrief } = require('../db/selects');

const include = {
  headDoctor: idAndName,
  doctors: { include: { doctor: doctorBrief } },
  _count: { select: { doctors: true, appointments: true, emergencyRequests: true } },
};

/** Departments for admin screens; deleted ones are hidden unless `deleted` is true */
const list = (deleted = false) => prisma.department.findMany({ where: { deletedAt: deleted ? { not: null } : null }, include, orderBy: { name: 'asc' } });

async function assertHeadExists(headDoctorId) {
  if (headDoctorId && !(await prisma.doctor.findUnique({ where: { id: headDoctorId } }))) throw ApiError.badRequest('Head doctor not found');
}
// The head of a department is always also a member of it
async function ensureHeadIsMember(dept) {
  if (dept.headDoctorId) {
    await prisma.doctorDepartment.upsert({
      where: { doctorId_departmentId: { doctorId: dept.headDoctorId, departmentId: dept.id } },
      create: { doctorId: dept.headDoctorId, departmentId: dept.id }, update: {},
    });
  }
}

async function create(data) {
  await assertHeadExists(data.headDoctorId);
  const dept = await prisma.department.create({ data, include });
  await ensureHeadIsMember(dept);
  return dept;
}

async function update(id, data) {
  await assertHeadExists(data.headDoctorId);
  const dept = await prisma.department.update({ where: { id }, data, include });
  await ensureHeadIsMember(dept);
  return dept;
}

/** Soft-deletes a department: deactivated and hidden, its history (appointments, emergencies) untouched. Never a hard delete. */
async function remove(id, admin) {
  const dept = await prisma.department.findUnique({ where: { id }, include: { _count: { select: { appointments: true, emergencyRequests: true } } } });
  if (!dept || dept.deletedAt) throw ApiError.notFound('Department not found');
  await prisma.department.update({ where: { id: dept.id }, data: { deletedAt: new Date(), deletedByUserId: admin.id, isActive: false } });
  return { dept, hadHistory: Boolean(dept._count.appointments || dept._count.emergencyRequests) };
}

async function restore(id) {
  const dept = await prisma.department.findUnique({ where: { id } });
  if (!dept || !dept.deletedAt) throw ApiError.notFound('No deleted department with this id');
  await prisma.department.update({ where: { id }, data: { deletedAt: null, deletedByUserId: null, isActive: true } });
  return dept;
}

module.exports = { list, create, update, remove, restore };
