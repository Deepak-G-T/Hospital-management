// TEST ORACLE ONLY — the previous in-memory analytics (copied unchanged from commit da2c751, before the SQL rewrite).
// tests/analytics.test.js checks that services/analytics.service.js returns exactly what this returns.
// It loads every row into memory, so never use it in the application.
const prisma = require('../../src/config/prisma');
const { startOfDay, endOfDay, startOfWeek, startOfMonth, addDays, formatDateKey } = require('../../src/utils/dates');

const DAY_MS = 86400000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Builds empty buckets for the range (daily, or monthly when the range is long) — bucketed in server local time
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
  const keyOf = (date) => (monthly ? formatDateKey(date).slice(0, 7) : formatDateKey(date));
  return { buckets, keyOf, granularity: monthly ? 'month' : 'day' };
}

const countBy = (rows, key) => rows.reduce((acc, r) => { acc[r[key]] = (acc[r[key]] || 0) + 1; return acc; }, {});
const toSeries = (obj, keys) => keys.map((k) => ({ name: k, value: obj[k] || 0 }));

async function adminAnalytics({ from, to, departmentId }) {
  const deptDoctorFilter = departmentId ? { departments: { some: { departmentId } } } : {};
  const apptWhere = { startAt: { gte: from, lte: to }, ...(departmentId ? { departmentId } : {}) };
  const emWhere = { createdAt: { gte: from, lte: to }, ...(departmentId ? { departmentId } : {}) };
  const now = new Date();

  const [
    totalDoctors, totalPatients, activeUsers, appointments, todayAppointments, emergencies, activeEmergencies,
    patientsInRange, departments, doctors, reviews, openComplaints,
  ] = await Promise.all([
    prisma.doctor.count({ where: { ...deptDoctorFilter, user: { isActive: true } } }),
    prisma.patient.count(),
    prisma.user.count({ where: { isActive: true } }),
    prisma.appointment.findMany({ where: apptWhere, select: { startAt: true, status: true, doctorId: true, departmentId: true, type: true } }),
    prisma.appointment.count({ where: { startAt: { gte: startOfDay(now), lte: endOfDay(now) }, ...(departmentId ? { departmentId } : {}) } }),
    prisma.emergencyRequest.findMany({ where: emWhere, select: { priority: true, status: true, createdAt: true, acceptedAt: true, departmentId: true, assignedDoctorId: true } }),
    prisma.emergencyRequest.count({ where: { status: { in: ['PENDING', 'NOTIFIED', 'ACCEPTED', 'ESCALATED'] }, ...(departmentId ? { departmentId } : {}) } }),
    prisma.patient.findMany({ where: { createdAt: { gte: from, lte: to } }, select: { createdAt: true } }),
    prisma.department.findMany({ where: { isActive: true, ...(departmentId ? { id: departmentId } : {}) }, select: { id: true, name: true, _count: { select: { doctors: true } } }, orderBy: { name: 'asc' } }),
    prisma.doctor.findMany({ where: deptDoctorFilter, select: { id: true, fullName: true, specialization: true } }),
    prisma.doctorReview.findMany({ where: { createdAt: { gte: from, lte: to }, ...(departmentId ? { doctor: deptDoctorFilter } : {}) }, select: { rating: true, doctorId: true } }),
    prisma.complaint.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
  ]);

  const statusCounts = countBy(appointments, 'status');

  // Appointment trend & registration trend
  const { buckets, keyOf, granularity } = buildBuckets(from, to);
  const apptTrend = new Map([...buckets.keys()].map((k) => [k, { date: k, total: 0, completed: 0, cancelled: 0, pending: 0 }]));
  appointments.forEach((a) => {
    const row = apptTrend.get(keyOf(a.startAt)); if (!row) return;
    row.total += 1;
    if (a.status === 'COMPLETED') row.completed += 1;
    if (['CANCELLED', 'REJECTED'].includes(a.status)) row.cancelled += 1;
    if (a.status === 'PENDING') row.pending += 1;
  });
  const regTrend = new Map([...buckets.keys()].map((k) => [k, { date: k, patients: 0 }]));
  patientsInRange.forEach((p) => { const row = regTrend.get(keyOf(p.createdAt)); if (row) row.patients += 1; });
  const emTrend = new Map([...buckets.keys()].map((k) => [k, { date: k, emergencies: 0 }]));
  emergencies.forEach((e) => { const row = emTrend.get(keyOf(e.createdAt)); if (row) row.emergencies += 1; });

  // Department stats
  const deptAppts = countBy(appointments.filter((a) => a.departmentId), 'departmentId');
  const deptCompleted = countBy(appointments.filter((a) => a.departmentId && a.status === 'COMPLETED'), 'departmentId');
  const deptEm = countBy(emergencies.filter((e) => e.departmentId), 'departmentId');
  const departmentStats = departments.map((d) => ({
    id: d.id, name: d.name, doctors: d._count.doctors, appointments: deptAppts[d.id] || 0, completed: deptCompleted[d.id] || 0, emergencies: deptEm[d.id] || 0,
  }));

  // Doctor performance
  const docAppts = countBy(appointments, 'doctorId');
  const docCompleted = countBy(appointments.filter((a) => a.status === 'COMPLETED'), 'doctorId');
  const docCancelled = countBy(appointments.filter((a) => ['CANCELLED', 'REJECTED', 'NO_SHOW'].includes(a.status)), 'doctorId');
  const docEm = countBy(emergencies.filter((e) => e.assignedDoctorId), 'assignedDoctorId');
  const ratingAgg = await prisma.doctorReview.groupBy({ by: ['doctorId'], _avg: { rating: true }, _count: { rating: true } });
  const ratingMap = Object.fromEntries(ratingAgg.map((r) => [r.doctorId, r]));
  const doctorPerformance = doctors.map((d) => ({
    id: d.id, name: d.fullName, specialization: d.specialization,
    appointments: docAppts[d.id] || 0, completed: docCompleted[d.id] || 0, cancelled: docCancelled[d.id] || 0,
    emergencies: docEm[d.id] || 0,
    rating: ratingMap[d.id]?._avg.rating ? Number(ratingMap[d.id]._avg.rating.toFixed(2)) : null,
    reviews: ratingMap[d.id]?._count.rating || 0,
    completionRate: docAppts[d.id] ? Math.round(((docCompleted[d.id] || 0) / docAppts[d.id]) * 100) : 0,
  })).sort((a, b) => b.appointments - a.appointments);

  // Satisfaction
  const ratingDist = [1, 2, 3, 4, 5].map((r) => ({ name: `${r}★`, rating: r, value: reviews.filter((x) => x.rating === r).length }));
  const avgRating = reviews.length ? Number((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(2)) : null;

  const accepted = emergencies.filter((e) => e.acceptedAt);
  const avgResponseMinutes = accepted.length
    ? Number((accepted.reduce((s, e) => s + (e.acceptedAt - e.createdAt), 0) / accepted.length / 60000).toFixed(1)) : null;

  return {
    range: { from, to, granularity },
    totals: {
      totalDoctors, totalPatients, activeUsers,
      totalAppointments: appointments.length,
      todayAppointments,
      pendingAppointments: statusCounts.PENDING || 0,
      confirmedAppointments: statusCounts.CONFIRMED || 0,
      completedAppointments: statusCounts.COMPLETED || 0,
      cancelledAppointments: (statusCounts.CANCELLED || 0) + (statusCounts.REJECTED || 0),
      emergencyCases: emergencies.length,
      activeEmergencies,
      openComplaints,
      avgRating,
      totalReviews: reviews.length,
      avgEmergencyResponseMinutes: avgResponseMinutes,
    },
    appointmentsByStatus: toSeries(statusCounts, ['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW']),
    appointmentTrend: [...apptTrend.values()],
    registrationTrend: [...regTrend.values()],
    emergencyTrend: [...emTrend.values()],
    emergenciesByPriority: toSeries(countBy(emergencies, 'priority'), ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    emergenciesByStatus: toSeries(countBy(emergencies, 'status'), ['PENDING', 'NOTIFIED', 'ACCEPTED', 'ESCALATED', 'RESOLVED', 'CANCELLED']),
    departmentStats,
    doctorPerformance,
    satisfaction: { average: avgRating, total: reviews.length, distribution: ratingDist },
  };
}

async function doctorAnalytics(doctorId, { from, to }) {
  const now = new Date();
  const [all, inRange, emergencies, ratingAgg, reviewsInRange, pendingRequests, uniquePatients] = await Promise.all([
    prisma.appointment.findMany({ where: { doctorId }, select: { startAt: true, status: true } }),
    prisma.appointment.findMany({ where: { doctorId, startAt: { gte: from, lte: to } }, select: { startAt: true, status: true, type: true } }),
    prisma.emergencyRequest.findMany({ where: { assignedDoctorId: doctorId, createdAt: { gte: from, lte: to } }, select: { priority: true, status: true, createdAt: true, acceptedAt: true } }),
    prisma.doctorReview.aggregate({ where: { doctorId }, _avg: { rating: true }, _count: { rating: true } }),
    prisma.doctorReview.findMany({ where: { doctorId, createdAt: { gte: from, lte: to } }, select: { rating: true } }),
    prisma.appointment.count({ where: { doctorId, status: 'PENDING', startAt: { gte: now } } }),
    prisma.appointment.findMany({ where: { doctorId }, distinct: ['patientId'], select: { patientId: true } }),
  ]);
  const activeOrDone = (a) => !['CANCELLED', 'REJECTED'].includes(a.status);
  const inWindow = (a, f, t) => a.startAt >= f && a.startAt <= t;

  const daily = all.filter((a) => activeOrDone(a) && inWindow(a, startOfDay(now), endOfDay(now))).length;
  const weekly = all.filter((a) => activeOrDone(a) && inWindow(a, startOfWeek(now), endOfDay(addDays(startOfWeek(now), 6)))).length;
  const monthly = all.filter((a) => activeOrDone(a) && inWindow(a, startOfMonth(now), endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0)))).length;

  const statusCounts = countBy(inRange, 'status');
  const { buckets, keyOf, granularity } = buildBuckets(from, to);
  const trend = new Map([...buckets.keys()].map((k) => [k, { date: k, total: 0, completed: 0, cancelled: 0 }]));
  inRange.forEach((a) => {
    const row = trend.get(keyOf(a.startAt)); if (!row) return;
    row.total += 1;
    if (a.status === 'COMPLETED') row.completed += 1;
    if (['CANCELLED', 'REJECTED'].includes(a.status)) row.cancelled += 1;
  });
  const weekdayCounts = WEEKDAYS.map((name, i) => ({ name, value: inRange.filter((a) => a.startAt.getDay() === i).length }));

  return {
    range: { from, to, granularity },
    totals: {
      totalConsultations: all.filter((a) => a.status === 'COMPLETED').length,
      dailyAppointments: daily,
      weeklyAppointments: weekly,
      monthlyAppointments: monthly,
      appointmentsInRange: inRange.length,
      completedAppointments: statusCounts.COMPLETED || 0,
      cancelledAppointments: (statusCounts.CANCELLED || 0) + (statusCounts.REJECTED || 0),
      pendingRequests,
      emergencyCases: emergencies.length,
      uniquePatients: uniquePatients.length,
      avgRating: ratingAgg._avg.rating ? Number(ratingAgg._avg.rating.toFixed(2)) : null,
      totalReviews: ratingAgg._count.rating,
    },
    appointmentsByStatus: toSeries(statusCounts, ['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW']),
    appointmentTrend: [...trend.values()],
    weekdayDistribution: weekdayCounts,
    emergenciesByPriority: toSeries(countBy(emergencies, 'priority'), ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    ratingDistribution: [1, 2, 3, 4, 5].map((r) => ({ name: `${r}★`, value: reviewsInRange.filter((x) => x.rating === r).length })),
  };
}

module.exports = { adminAnalytics, doctorAnalytics };
