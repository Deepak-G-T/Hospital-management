// Doctor accounts managed by the admin: list, create, edit, departments, delete/deactivate.
const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { hashPassword } = require('./password.service');
const { notifyUser } = require('./notification.service');
const { disconnectUser } = require('../socket');
const { departmentRef } = require('../db/selects');
const { paginateQuery } = require('../utils/pagination');

const DEFAULT_AVAILABILITY = [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, startTime: '09:00', endTime: '17:00' }));

const doctorInclude = {
  user: { select: { id: true, email: true, isActive: true, lastLoginAt: true, createdAt: true } },
  departments: { include: { department: departmentRef }, orderBy: { isPrimary: 'desc' } },
  availability: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] },
  _count: { select: { appointments: true, reviews: true, assignedEmergencies: true } },
};

function departmentLinks(departmentIds = [], primaryDepartmentId) {
  const ids = [...new Set(departmentIds)];
  const primary = primaryDepartmentId && ids.includes(primaryDepartmentId) ? primaryDepartmentId : ids[0];
  return ids.map((departmentId) => ({ departmentId, isPrimary: departmentId === primary }));
}

async function assertDepartmentsExist(ids) {
  if (!ids?.length) return;
  const count = await prisma.department.count({ where: { id: { in: ids } } });
  if (count !== new Set(ids).size) throw ApiError.badRequest('One or more departments do not exist');
}

async function list({ search, departmentId, status, ...rest }) {
  const where = {
    ...(departmentId ? { departments: { some: { departmentId } } } : {}),
    // deleted doctors are hidden unless asked for (status=deleted)
    ...(status === 'deleted' ? { deletedAt: { not: null } } : { deletedAt: null }),
    ...(status === 'active' ? { user: { isActive: true } } : status === 'inactive' ? { user: { isActive: false } } : {}),
    ...(search ? {
      OR: [
        { fullName: { contains: search, mode: 'insensitive' } },
        { specialization: { contains: search, mode: 'insensitive' } },
        { licenseNumber: { contains: search, mode: 'insensitive' } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ],
    } : {}),
  };
  return paginateQuery(prisma.doctor, { where, include: doctorInclude, orderBy: { createdAt: 'desc' } }, rest);
}

async function get(id) {
  const doctor = await prisma.doctor.findUnique({ where: { id }, include: doctorInclude });
  if (!doctor) throw ApiError.notFound('Doctor not found');
  return doctor;
}

/** Creates the login account and the doctor profile (default Mon–Fri schedule unless given) */
async function create({ email, password, departmentIds, primaryDepartmentId, availability, ...profile }) {
  await assertDepartmentsExist(departmentIds);
  const passwordHash = await hashPassword(password);
  const doctor = await prisma.$transaction(async (tx) => {
    if (await tx.user.findUnique({ where: { email } })) throw ApiError.conflict('An account with this email already exists');
    if (await tx.doctor.findUnique({ where: { licenseNumber: profile.licenseNumber } })) throw ApiError.conflict('License number already registered');
    const user = await tx.user.create({ data: { email, passwordHash, role: 'DOCTOR' } });
    return tx.doctor.create({
      data: {
        ...profile,
        userId: user.id,
        departments: { create: departmentLinks(departmentIds, primaryDepartmentId) },
        availability: { create: availability?.length ? availability : DEFAULT_AVAILABILITY },
      },
      include: doctorInclude,
    });
  });
  await notifyUser(doctor.userId, { type: 'SYSTEM', title: 'Welcome to MediCore', message: 'Your doctor account has been created by the hospital administration.', link: '/doctor' });
  return doctor;
}

async function update(id, { email, departmentIds, primaryDepartmentId, ...profile }) {
  const existing = await prisma.doctor.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Doctor not found');
  if (departmentIds) await assertDepartmentsExist(departmentIds);
  return prisma.$transaction(async (tx) => {
    if (email) await tx.user.update({ where: { id: existing.userId }, data: { email } });
    if (departmentIds) {
      await tx.doctorDepartment.deleteMany({ where: { doctorId: existing.id } });
      await tx.doctorDepartment.createMany({ data: departmentLinks(departmentIds, primaryDepartmentId).map((l) => ({ ...l, doctorId: existing.id })) });
    }
    return tx.doctor.update({ where: { id: existing.id }, data: profile, include: doctorInclude });
  });
}

async function assignDepartments(id, { departmentIds, primaryDepartmentId }) {
  await assertDepartmentsExist(departmentIds);
  const doctor = await prisma.doctor.findUnique({ where: { id } });
  if (!doctor) throw ApiError.notFound('Doctor not found');
  await prisma.$transaction([
    prisma.doctorDepartment.deleteMany({ where: { doctorId: doctor.id } }),
    prisma.doctorDepartment.createMany({ data: departmentLinks(departmentIds, primaryDepartmentId).map((l) => ({ ...l, doctorId: doctor.id })) }),
  ]);
  await notifyUser(doctor.userId, { type: 'SYSTEM', title: 'Departments updated', message: 'Your department assignments were updated by the administration.', link: '/doctor/profile' });
  return prisma.doctor.findUnique({ where: { id: doctor.id }, include: doctorInclude });
}

/**
 * Soft-deletes the doctor: the account is deactivated and the doctor is hidden from admin lists, but the row and everything
 * that refers to it (appointments, prescriptions, reviews, referrals, emergency history) are kept. Future appointments are
 * cancelled. Never a hard delete. Returns { doctor, hadHistory }; restore() undoes it.
 */
async function remove(id, admin) {
  const doctor = await prisma.doctor.findUnique({ where: { id }, include: { _count: { select: { appointments: true, prescriptions: true } } } });
  if (!doctor || doctor.deletedAt) throw ApiError.notFound('Doctor not found');
  await prisma.$transaction([
    prisma.doctor.update({ where: { id: doctor.id }, data: { deletedAt: new Date(), deletedByUserId: admin.id } }),
    prisma.user.update({ where: { id: doctor.userId }, data: { isActive: false } }),
    prisma.appointment.updateMany({
      where: { doctorId: doctor.id, status: { in: ['PENDING', 'CONFIRMED'] }, startAt: { gt: new Date() } },
      data: { status: 'CANCELLED', statusReason: 'Doctor no longer available', cancelledAt: new Date() },
    }),
  ]);
  disconnectUser(doctor.userId);
  return { doctor, hadHistory: Boolean(doctor._count.appointments || doctor._count.prescriptions) };
}

/** Brings a soft-deleted doctor back (active again). Appointments cancelled by the deletion stay cancelled. */
async function restore(id) {
  const doctor = await prisma.doctor.findUnique({ where: { id } });
  if (!doctor || !doctor.deletedAt) throw ApiError.notFound('No deleted doctor with this id');
  await prisma.$transaction([
    prisma.doctor.update({ where: { id }, data: { deletedAt: null, deletedByUserId: null } }),
    prisma.user.update({ where: { id: doctor.userId }, data: { isActive: true } }),
  ]);
  return doctor;
}

module.exports = { list, get, create, update, assignDepartments, remove, restore };
