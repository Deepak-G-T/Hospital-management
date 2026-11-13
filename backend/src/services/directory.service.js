// Public, read-only listings for the website: stats, departments and doctors (with ratings).
const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { idAndName } = require('../db/selects');

const publicDoctorSelect = {
  id: true, fullName: true, gender: true, specialization: true, qualification: true, experienceYears: true,
  consultationFee: true, bio: true, avatarUrl: true, slotDurationMinutes: true,
  departments: { select: { isPrimary: true, department: { select: { id: true, name: true, icon: true } } } },
};
const round1 = (n) => (n ? Number(n.toFixed(1)) : null);

/** Adds { rating, reviewCount } from visible reviews */
async function attachRatings(doctors) {
  const agg = await prisma.doctorReview.groupBy({
    by: ['doctorId'], where: { doctorId: { in: doctors.map((d) => d.id) }, isVisible: true }, _avg: { rating: true }, _count: { rating: true },
  });
  const map = Object.fromEntries(agg.map((a) => [a.doctorId, a]));
  return doctors.map((d) => ({ ...d, rating: round1(map[d.id]?._avg.rating), reviewCount: map[d.id]?._count.rating || 0 }));
}

async function stats() {
  const [doctors, patients, departments, completed, rating] = await Promise.all([
    prisma.doctor.count({ where: { user: { isActive: true } } }),
    prisma.patient.count(),
    prisma.department.count({ where: { isActive: true } }),
    prisma.appointment.count({ where: { status: 'COMPLETED' } }),
    prisma.doctorReview.aggregate({ _avg: { rating: true } }),
  ]);
  return { doctors, patients, departments, completedAppointments: completed, avgRating: round1(rating._avg.rating) };
}

const listDepartments = (search) => prisma.department.findMany({
  where: { isActive: true, ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }] } : {}) },
  select: {
    id: true, name: true, description: true, location: true, phone: true, icon: true, isEmergency: true,
    headDoctor: idAndName,
    _count: { select: { doctors: true } },
  },
  orderBy: { name: 'asc' },
});

async function getDepartment(id) {
  const dept = await prisma.department.findFirst({
    where: { id, isActive: true },
    select: {
      id: true, name: true, description: true, location: true, phone: true, icon: true, isEmergency: true,
      headDoctor: idAndName,
      doctors: { where: { doctor: { user: { isActive: true } } }, select: { doctor: { select: publicDoctorSelect } } },
    },
  });
  if (!dept) throw ApiError.notFound('Department not found');
  return { ...dept, doctors: await attachRatings(dept.doctors.map((d) => d.doctor)) };
}

async function listDoctors({ search, departmentId }) {
  const where = {
    user: { isActive: true },
    ...(departmentId ? { departments: { some: { departmentId } } } : {}),
    ...(search ? {
      OR: [
        { fullName: { contains: search, mode: 'insensitive' } },
        { specialization: { contains: search, mode: 'insensitive' } },
        { departments: { some: { department: { name: { contains: search, mode: 'insensitive' } } } } },
      ],
    } : {}),
  };
  const doctors = await prisma.doctor.findMany({ where, select: { ...publicDoctorSelect, availability: { where: { isActive: true }, select: { dayOfWeek: true } } }, orderBy: { fullName: 'asc' } });
  const withRatings = await attachRatings(doctors);
  return withRatings.map(({ availability, ...d }) => ({ ...d, availableDays: [...new Set(availability.map((a) => a.dayOfWeek))].sort() }));
}

async function getDoctor(id) {
  const doctor = await prisma.doctor.findFirst({
    where: { id, user: { isActive: true } },
    select: {
      ...publicDoctorSelect,
      availability: { where: { isActive: true }, orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }], select: { dayOfWeek: true, startTime: true, endTime: true } },
      reviews: {
        where: { isVisible: true }, orderBy: { createdAt: 'desc' }, take: 20,
        select: { id: true, rating: true, comment: true, createdAt: true, patient: { select: { fullName: true } } },
      },
      _count: { select: { appointments: { where: { status: 'COMPLETED' } } } },
    },
  });
  if (!doctor) throw ApiError.notFound('Doctor not found');
  const [withRating] = await attachRatings([doctor]);
  // Only show the patient's first name + initial, for privacy
  withRating.reviews = withRating.reviews.map((r) => {
    const [first, last] = r.patient.fullName.split(' ');
    return { ...r, patient: { fullName: `${first}${last ? ` ${last[0]}.` : ''}` } };
  });
  return withRating;
}

module.exports = { stats, listDepartments, getDepartment, listDoctors, getDoctor };
