// Admin reports: tabular data for a date range, as JSON rows or CSV.
const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { adminAnalytics } = require('./analytics.service');
const { adminInclude: complaintInclude } = require('./complaint.service');
const { nameOnly, departmentName } = require('../db/selects');
const { startOfDay } = require('../utils/dates');

const fmtDate = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '');

/** Returns { columns, rows } for a report type */
async function build(type, { from, to, departmentId }) {
  const inRange = { gte: from, lte: to };
  switch (type) {
    case 'appointments': {
      const rows = await prisma.appointment.findMany({
        where: { startAt: inRange, ...(departmentId ? { departmentId } : {}) }, orderBy: { startAt: 'asc' },
        include: { patient: nameOnly, doctor: nameOnly, department: departmentName },
      });
      return {
        columns: ['Date', 'Patient', 'Doctor', 'Department', 'Type', 'Status', 'Reason'],
        rows: rows.map((r) => [fmtDate(r.startAt), r.patient.fullName, r.doctor.fullName, r.department?.name || '', r.type, r.status, r.reason || '']),
      };
    }
    case 'doctors': {
      const a = await adminAnalytics({ from, to, departmentId });
      return {
        columns: ['Doctor', 'Specialization', 'Appointments', 'Completed', 'Cancelled', 'Completion %', 'Emergencies', 'Avg rating', 'Reviews'],
        rows: a.doctorPerformance.map((d) => [d.name, d.specialization, d.appointments, d.completed, d.cancelled, d.completionRate, d.emergencies, d.rating ?? '', d.reviews]),
      };
    }
    case 'departments': {
      const a = await adminAnalytics({ from, to, departmentId });
      return { columns: ['Department', 'Doctors', 'Appointments', 'Completed', 'Emergencies'], rows: a.departmentStats.map((d) => [d.name, d.doctors, d.appointments, d.completed, d.emergencies]) };
    }
    case 'patients': {
      const rows = await prisma.patient.findMany({
        where: { createdAt: inRange }, orderBy: { createdAt: 'asc' },
        include: { user: { select: { email: true } }, _count: { select: { appointments: true, emergencyRequests: true } } },
      });
      return {
        // registration data only: clinical fields such as blood group are never exported
        columns: ['Registered', 'Name', 'Email', 'Gender', 'Appointments', 'Emergencies'],
        rows: rows.map((p) => [fmtDate(p.createdAt), p.fullName, p.user.email, p.gender || '', p._count.appointments, p._count.emergencyRequests]),
      };
    }
    case 'emergencies': {
      const rows = await prisma.emergencyRequest.findMany({
        where: { createdAt: inRange, ...(departmentId ? { departmentId } : {}) }, orderBy: { createdAt: 'asc' },
        include: { patient: nameOnly, department: departmentName, assignedDoctor: nameOnly },
      });
      return {
        columns: ['Created', 'Patient', 'Priority', 'Status', 'Department', 'Assigned doctor', 'Response (min)', 'Escalations'],
        rows: rows.map((e) => [fmtDate(e.createdAt), e.patient.fullName, e.priority, e.status, e.department?.name || '', e.assignedDoctor?.fullName || '',
          e.acceptedAt ? ((e.acceptedAt - e.createdAt) / 60000).toFixed(1) : '', e.escalationLevel]),
      };
    }
    case 'complaints': {
      const rows = await prisma.complaint.findMany({ where: { createdAt: inRange }, orderBy: { createdAt: 'asc' }, include: complaintInclude });
      return {
        columns: ['Created', 'From', 'Category', 'Subject', 'Status', 'Responded'],
        rows: rows.map((c) => [fmtDate(c.createdAt), c.complainant ? `${c.complainant.email} (${c.complainant.role})` : `${c.guestName} <${c.guestEmail}> (guest)`, c.category, c.subject, c.status, fmtDate(c.respondedAt)]),
      };
    }
    default:
      throw ApiError.badRequest('Unknown report type');
  }
}

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // CSV injection guard
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (report) => [report.columns, ...report.rows].map((r) => r.map(csvCell).join(',')).join('\n');

// Reports that list patients by name (or contact) — "patient-identifying". They need a recorded reason and a bounded date range.
const IDENTIFYING_TYPES = ['patients', 'appointments', 'emergencies', 'complaints'];
const MAX_RANGE_DAYS = 366;

/** Number of calendar days covered by { from, to } (inclusive) */
const rangeDays = ({ from, to }) => Math.round((startOfDay(to) - startOfDay(from)) / 86400000) + 1;

/** Throws a 400 with details.code = EXPORT_RANGE_TOO_LARGE / EXPORT_RANGE_INVALID */
function assertExportRange(range) {
  if (range.from > range.to) throw ApiError.badRequest('The start date is after the end date.', { code: 'EXPORT_RANGE_INVALID' });
  const days = rangeDays(range);
  if (days > MAX_RANGE_DAYS) {
    throw ApiError.badRequest(`The date range covers ${days} days; patient-identifying exports are limited to ${MAX_RANGE_DAYS} days. Choose a shorter period.`, { code: 'EXPORT_RANGE_TOO_LARGE', maxDays: MAX_RANGE_DAYS, days });
  }
}

module.exports = { build, toCsv, IDENTIFYING_TYPES, MAX_RANGE_DAYS, assertExportRange };
