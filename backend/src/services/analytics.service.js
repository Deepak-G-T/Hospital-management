const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const { startOfDay, endOfDay, startOfWeek, startOfMonth, addDays, formatDateKey } = require('../utils/dates');
const { ACTIVE_EMERGENCY_STATUSES } = require('../utils/constants');
const { nameOnly, departmentName } = require('../db/selects');
const { appointmentInclude, adminView } = require('./appointment.service');

const DAY_MS = 86400000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Builds the empty buckets for the range (daily, or monthly when the range is longer than 92 days) in server local time.
// The SQL queries fill them using the same timezone.
function buildBuckets(from, to) {
  const monthly = (to - from) / DAY_MS > 92;
  const buckets = new Map();
  if (monthly) {
    const d = new Date(from.getFullYear(), from.getMonth(), 1);
    while (d <= to) {
      buckets.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, {});
      d.setMonth(d.getMonth() + 1);
    }
  } else {
    for (let d = startOfDay(from); d <= to; d = addDays(d, 1)) buckets.set(formatDateKey(d), {});
  }
  return { buckets, granularity: monthly ? 'month' : 'day' };
}

const toSeries = (obj, keys) => keys.map((k) => ({ name: k, value: obj[k] || 0 }));
const sumBy = (rows, pick) => rows.reduce((acc, r) => { const k = pick(r); if (k != null) acc[k] = (acc[k] || 0) + r._count._all; return acc; }, {});
const CANCELLED = ['CANCELLED', 'REJECTED'];

// ── SQL helpers ──
// Counting happens in PostgreSQL; only the aggregated rows come back. Day/month buckets and weekdays are computed
// in the same timezone the Node process uses (TZ), exactly like the previous in-memory bucketing.
const serverTimeZone = () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const iso = (d) => d.toISOString(); // explicit timestamptz parameters, independent of the database session timezone
const deptFilter = (departmentId) => (departmentId ? Prisma.sql`AND department_id = ${departmentId}::uuid` : Prisma.empty);
const bucketFormat = (granularity) => (granularity === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD');

/** Appointments per bucket and status in the range (optionally for one department or one doctor) */
const appointmentBuckets = ({ from, to, granularity, departmentId, doctorId }) => prisma.$queryRaw`
  SELECT to_char(start_at AT TIME ZONE ${serverTimeZone()}, ${bucketFormat(granularity)}) AS bucket, status::text AS status, count(*)::int AS n
  FROM appointments
  WHERE start_at >= ${iso(from)}::timestamptz AND start_at <= ${iso(to)}::timestamptz ${deptFilter(departmentId)}
    ${doctorId ? Prisma.sql`AND doctor_id = ${doctorId}::uuid` : Prisma.empty}
  GROUP BY 1, 2`;

/** Rows per bucket of a table's created_at (patients, emergencies) */
const createdBuckets = (table, { from, to, granularity, departmentId }) => prisma.$queryRaw`
  SELECT to_char(created_at AT TIME ZONE ${serverTimeZone()}, ${bucketFormat(granularity)}) AS bucket, count(*)::int AS n
  FROM ${Prisma.raw(table)}
  WHERE created_at >= ${iso(from)}::timestamptz AND created_at <= ${iso(to)}::timestamptz ${deptFilter(departmentId)}
  GROUP BY 1`;

/** Sum (in whole milliseconds, as JavaScript Dates see them) and count of emergency response times in the range */
const responseTimes = ({ from, to, departmentId }) => prisma.$queryRaw`
  SELECT count(*)::int AS n,
         coalesce(sum(extract(epoch FROM date_trunc('milliseconds', accepted_at) - date_trunc('milliseconds', created_at)) * 1000), 0)::float8 AS ms
  FROM emergency_requests
  WHERE accepted_at IS NOT NULL AND created_at >= ${iso(from)}::timestamptz AND created_at <= ${iso(to)}::timestamptz ${deptFilter(departmentId)}`;

/** Fills the empty buckets with SQL counts */
function trendRows(buckets, rows, make, add) {
  const trend = new Map([...buckets.keys()].map((k) => [k, make(k)]));
  rows.forEach((r) => { const row = trend.get(r.bucket); if (row) add(row, r); });
  return [...trend.values()];
}
const addAppointment = (row, r) => {
  row.total += r.n;
  if (r.status === 'COMPLETED') row.completed += r.n;
  if (CANCELLED.includes(r.status)) row.cancelled += r.n;
  if ('pending' in row && r.status === 'PENDING') row.pending += r.n;
};

async function adminAnalytics({ from, to, departmentId }) {
  const deptDoctorFilter = departmentId ? { departments: { some: { departmentId } } } : {};
  const apptWhere = { startAt: { gte: from, lte: to }, ...(departmentId ? { departmentId } : {}) };
  const emWhere = { createdAt: { gte: from, lte: to }, ...(departmentId ? { departmentId } : {}) };
  const reviewWhere = { createdAt: { gte: from, lte: to }, ...(departmentId ? { doctor: deptDoctorFilter } : {}) };
  const { buckets, granularity } = buildBuckets(from, to);
  const now = new Date();

  const [
    totalDoctors, totalPatients, activeUsers, todayAppointments, activeEmergencies, departments, doctors, openComplaints,
    apptByStatus, apptByDept, apptByDoctor, apptTrendRows,
    emByPriority, emByStatus, emByDept, emByDoctor, emTrendRows, response,
    regTrendRows, reviewsByRating, ratingAgg,
  ] = await Promise.all([
    prisma.doctor.count({ where: { ...deptDoctorFilter, user: { isActive: true } } }),
    prisma.patient.count(),
    prisma.user.count({ where: { isActive: true } }),
    prisma.appointment.count({ where: { startAt: { gte: startOfDay(now), lte: endOfDay(now) }, ...(departmentId ? { departmentId } : {}) } }),
    prisma.emergencyRequest.count({ where: { status: { in: ['PENDING', 'NOTIFIED', 'ACCEPTED', 'ESCALATED'] }, ...(departmentId ? { departmentId } : {}) } }),
    prisma.department.findMany({ where: { isActive: true, ...(departmentId ? { id: departmentId } : {}) }, select: { id: true, name: true, _count: { select: { doctors: true } } }, orderBy: { name: 'asc' } }),
    prisma.doctor.findMany({ where: deptDoctorFilter, select: { id: true, fullName: true, specialization: true } }),
    prisma.complaint.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
    prisma.appointment.groupBy({ by: ['status'], where: apptWhere, _count: { _all: true } }),
    prisma.appointment.groupBy({ by: ['departmentId', 'status'], where: { ...apptWhere, departmentId: departmentId || { not: null } }, _count: { _all: true } }),
    prisma.appointment.groupBy({ by: ['doctorId', 'status'], where: apptWhere, _count: { _all: true } }),
    appointmentBuckets({ from, to, granularity, departmentId }),
    prisma.emergencyRequest.groupBy({ by: ['priority'], where: emWhere, _count: { _all: true } }),
    prisma.emergencyRequest.groupBy({ by: ['status'], where: emWhere, _count: { _all: true } }),
    prisma.emergencyRequest.groupBy({ by: ['departmentId'], where: { ...emWhere, departmentId: departmentId || { not: null } }, _count: { _all: true } }),
    prisma.emergencyRequest.groupBy({ by: ['assignedDoctorId'], where: { ...emWhere, assignedDoctorId: { not: null } }, _count: { _all: true } }),
    createdBuckets('emergency_requests', { from, to, granularity, departmentId }),
    responseTimes({ from, to, departmentId }),
    createdBuckets('patients', { from, to, granularity }),
    prisma.doctorReview.groupBy({ by: ['rating'], where: reviewWhere, _count: { _all: true } }),
    prisma.doctorReview.groupBy({ by: ['doctorId'], _avg: { rating: true }, _count: { rating: true } }),
  ]);

  const statusCounts = sumBy(apptByStatus, (r) => r.status);
  const totalAppointments = Object.values(statusCounts).reduce((a, b) => a + b, 0);

  // Trends
  const appointmentTrend = trendRows(buckets, apptTrendRows, (k) => ({ date: k, total: 0, completed: 0, cancelled: 0, pending: 0 }), addAppointment);
  const registrationTrend = trendRows(buckets, regTrendRows, (k) => ({ date: k, patients: 0 }), (row, r) => { row.patients += r.n; });
  const emergencyTrend = trendRows(buckets, emTrendRows, (k) => ({ date: k, emergencies: 0 }), (row, r) => { row.emergencies += r.n; });

  // Department stats
  const deptAppts = sumBy(apptByDept, (r) => r.departmentId);
  const deptCompleted = sumBy(apptByDept.filter((r) => r.status === 'COMPLETED'), (r) => r.departmentId);
  const deptEm = sumBy(emByDept, (r) => r.departmentId);
  const departmentStats = departments.map((d) => ({
    id: d.id, name: d.name, doctors: d._count.doctors, appointments: deptAppts[d.id] || 0, completed: deptCompleted[d.id] || 0, emergencies: deptEm[d.id] || 0,
  }));

  // Doctor performance
  const docAppts = sumBy(apptByDoctor, (r) => r.doctorId);
  const docCompleted = sumBy(apptByDoctor.filter((r) => r.status === 'COMPLETED'), (r) => r.doctorId);
  const docCancelled = sumBy(apptByDoctor.filter((r) => ['CANCELLED', 'REJECTED', 'NO_SHOW'].includes(r.status)), (r) => r.doctorId);
  const docEm = sumBy(emByDoctor, (r) => r.assignedDoctorId);
  const ratingMap = Object.fromEntries(ratingAgg.map((r) => [r.doctorId, r]));
  const doctorPerformance = doctors.map((d) => ({
    id: d.id, name: d.fullName, specialization: d.specialization,
    appointments: docAppts[d.id] || 0, completed: docCompleted[d.id] || 0, cancelled: docCancelled[d.id] || 0,
    emergencies: docEm[d.id] || 0,
    rating: ratingMap[d.id]?._avg.rating ? Number(ratingMap[d.id]._avg.rating.toFixed(2)) : null,
    reviews: ratingMap[d.id]?._count.rating || 0,
    completionRate: docAppts[d.id] ? Math.round(((docCompleted[d.id] || 0) / docAppts[d.id]) * 100) : 0,
  })).sort((a, b) => b.appointments - a.appointments);

  // Satisfaction (exact integer sums, same rounding as before)
  const ratingCounts = sumBy(reviewsByRating, (r) => r.rating);
  const totalReviews = Object.values(ratingCounts).reduce((a, b) => a + b, 0);
  const ratingSum = Object.entries(ratingCounts).reduce((s, [rating, n]) => s + Number(rating) * n, 0);
  const ratingDist = [1, 2, 3, 4, 5].map((r) => ({ name: `${r}★`, rating: r, value: ratingCounts[r] || 0 }));
  const avgRating = totalReviews ? Number((ratingSum / totalReviews).toFixed(2)) : null;

  const [{ n: acceptedCount, ms: responseMs }] = response;
  const avgResponseMinutes = acceptedCount ? Number((responseMs / acceptedCount / 60000).toFixed(1)) : null;
  const emergencyCases = emByStatus.reduce((s, r) => s + r._count._all, 0);

  return {
    range: { from, to, granularity },
    totals: {
      totalDoctors, totalPatients, activeUsers,
      totalAppointments,
      todayAppointments,
      pendingAppointments: statusCounts.PENDING || 0,
      confirmedAppointments: statusCounts.CONFIRMED || 0,
      completedAppointments: statusCounts.COMPLETED || 0,
      cancelledAppointments: (statusCounts.CANCELLED || 0) + (statusCounts.REJECTED || 0),
      emergencyCases,
      activeEmergencies,
      openComplaints,
      avgRating,
      totalReviews,
      avgEmergencyResponseMinutes: avgResponseMinutes,
    },
    appointmentsByStatus: toSeries(statusCounts, ['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW']),
    appointmentTrend,
    registrationTrend,
    emergencyTrend,
    emergenciesByPriority: toSeries(sumBy(emByPriority, (r) => r.priority), ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    emergenciesByStatus: toSeries(sumBy(emByStatus, (r) => r.status), ['PENDING', 'NOTIFIED', 'ACCEPTED', 'ESCALATED', 'RESOLVED', 'CANCELLED']),
    departmentStats,
    doctorPerformance,
    satisfaction: { average: avgRating, total: totalReviews, distribution: ratingDist },
  };
}

async function doctorAnalytics(doctorId, { from, to }) {
  const now = new Date();
  const { buckets, granularity } = buildBuckets(from, to);
  const notCancelled = { status: { notIn: CANCELLED } };
  const countBetween = (f, t) => prisma.appointment.count({ where: { doctorId, ...notCancelled, startAt: { gte: f, lte: t } } });
  const inRange = { doctorId, startAt: { gte: from, lte: to } };

  const [totalConsultations, daily, weekly, monthly, byStatus, trendRowsSql, weekdayRows, emByPriority, ratingAgg, reviewsByRating, pendingRequests, uniquePatients] = await Promise.all([
    prisma.appointment.count({ where: { doctorId, status: 'COMPLETED' } }),
    countBetween(startOfDay(now), endOfDay(now)),
    countBetween(startOfWeek(now), endOfDay(addDays(startOfWeek(now), 6))),
    countBetween(startOfMonth(now), endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0))),
    prisma.appointment.groupBy({ by: ['status'], where: inRange, _count: { _all: true } }),
    appointmentBuckets({ from, to, granularity, doctorId }),
    prisma.$queryRaw`
      SELECT extract(dow FROM start_at AT TIME ZONE ${serverTimeZone()})::int AS dow, count(*)::int AS n
      FROM appointments WHERE doctor_id = ${doctorId}::uuid AND start_at >= ${iso(from)}::timestamptz AND start_at <= ${iso(to)}::timestamptz
      GROUP BY 1`,
    prisma.emergencyRequest.groupBy({ by: ['priority'], where: { assignedDoctorId: doctorId, createdAt: { gte: from, lte: to } }, _count: { _all: true } }),
    prisma.doctorReview.aggregate({ where: { doctorId }, _avg: { rating: true }, _count: { rating: true } }),
    prisma.doctorReview.groupBy({ by: ['rating'], where: { doctorId, createdAt: { gte: from, lte: to } }, _count: { _all: true } }),
    prisma.appointment.count({ where: { doctorId, status: 'PENDING', startAt: { gte: now } } }),
    prisma.$queryRaw`SELECT count(DISTINCT patient_id)::int AS n FROM appointments WHERE doctor_id = ${doctorId}::uuid`,
  ]);

  const statusCounts = sumBy(byStatus, (r) => r.status);
  const weekday = Object.fromEntries(weekdayRows.map((r) => [r.dow, r.n]));
  const ratings = sumBy(reviewsByRating, (r) => r.rating);
  const priorities = sumBy(emByPriority, (r) => r.priority);

  return {
    range: { from, to, granularity },
    totals: {
      totalConsultations,
      dailyAppointments: daily,
      weeklyAppointments: weekly,
      monthlyAppointments: monthly,
      appointmentsInRange: Object.values(statusCounts).reduce((a, b) => a + b, 0),
      completedAppointments: statusCounts.COMPLETED || 0,
      cancelledAppointments: (statusCounts.CANCELLED || 0) + (statusCounts.REJECTED || 0),
      pendingRequests,
      emergencyCases: Object.values(priorities).reduce((a, b) => a + b, 0),
      uniquePatients: uniquePatients[0].n,
      avgRating: ratingAgg._avg.rating ? Number(ratingAgg._avg.rating.toFixed(2)) : null,
      totalReviews: ratingAgg._count.rating,
    },
    appointmentsByStatus: toSeries(statusCounts, ['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW']),
    appointmentTrend: trendRows(buckets, trendRowsSql, (k) => ({ date: k, total: 0, completed: 0, cancelled: 0 }), addAppointment),
    weekdayDistribution: WEEKDAYS.map((name, i) => ({ name, value: weekday[i] || 0 })),
    emergenciesByPriority: toSeries(priorities, ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    ratingDistribution: [1, 2, 3, 4, 5].map((r) => ({ name: `${r}★`, value: ratings[r] || 0 })),
  };
}

// ── Dashboards: analytics plus the live lists shown next to them ──
/** Admin dashboard: analytics for the range + active emergencies and the latest bookings */
async function adminDashboard({ from, to, departmentId }) {
  const [data, recentEmergencies, recentAppointments] = await Promise.all([
    adminAnalytics({ from, to, departmentId }),
    prisma.emergencyRequest.findMany({
      where: { status: { in: ACTIVE_EMERGENCY_STATUSES } }, orderBy: { createdAt: 'desc' }, take: 5,
      include: { patient: nameOnly, department: departmentName, assignedDoctor: nameOnly },
    }),
    prisma.appointment.findMany({ orderBy: { createdAt: 'desc' }, take: 6, include: appointmentInclude }),
  ]);
  return { ...data, recentEmergencies, recentAppointments: recentAppointments.map(adminView) };
}

/** Doctor dashboard: analytics for the range + today's agenda, pending requests and active emergencies */
async function doctorDashboard(doctorId, range) {
  const now = new Date();
  const [analytics, todays, pending, emergencies] = await Promise.all([
    doctorAnalytics(doctorId, range),
    prisma.appointment.findMany({
      where: { doctorId, startAt: { gte: startOfDay(now), lte: endOfDay(now) }, status: { in: ['PENDING', 'CONFIRMED', 'COMPLETED'] } },
      include: appointmentInclude, orderBy: { startAt: 'asc' },
    }),
    prisma.appointment.findMany({ where: { doctorId, status: 'PENDING', startAt: { gte: now } }, include: appointmentInclude, orderBy: { startAt: 'asc' }, take: 5 }),
    prisma.emergencyRequest.findMany({
      where: { status: { in: ['NOTIFIED', 'ESCALATED', 'ACCEPTED', 'PENDING'] }, OR: [{ assignedDoctorId: doctorId }, { notifications: { some: { doctorId, status: { in: ['SENT', 'SEEN'] } } } }] },
      include: { patient: nameOnly, department: departmentName }, orderBy: { createdAt: 'desc' },
    }),
  ]);
  return { ...analytics, todaysAppointments: todays, pendingRequests: pending, activeEmergencies: emergencies };
}

module.exports = { adminAnalytics, doctorAnalytics, adminDashboard, doctorDashboard };
