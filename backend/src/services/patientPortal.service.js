// The patient's own portal: dashboard, profile, allergies and reviews.
// Appointments, emergencies, prescriptions, records and reports have their own services.
const { markDeleted, restoreOwn } = require('./softDelete.service');
const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { notifyUser } = require('./notification.service');
const { appointmentInclude } = require('./appointment.service');
const { emergencyInclude } = require('./emergency.service');
const { nameOnly, doctorNameAndSpecialty } = require('../db/selects');
const { ACTIVE_EMERGENCY_STATUSES } = require('../utils/constants');
const { paginateQuery } = require('../utils/pagination');

const getPatient = (patientId) => prisma.patient.findUnique({ where: { id: patientId } });

async function dashboard(patientId, userId) {
  const now = new Date();
  const [upcoming, counts, activeEmergency, prescriptions, unread, allergies, patient, pendingReviews] = await Promise.all([
    prisma.appointment.findMany({ where: { patientId, startAt: { gte: now }, status: { in: ['PENDING', 'CONFIRMED'] } }, include: appointmentInclude, orderBy: { startAt: 'asc' }, take: 5 }),
    prisma.appointment.groupBy({ by: ['status'], where: { patientId }, _count: { _all: true } }),
    prisma.emergencyRequest.findFirst({ where: { patientId, status: { in: ACTIVE_EMERGENCY_STATUSES } }, include: emergencyInclude }),
    prisma.prescription.findMany({ where: { patientId }, include: { doctor: nameOnly, items: true }, orderBy: { createdAt: 'desc' }, take: 3 }),
    prisma.notification.count({ where: { userId, isRead: false } }),
    prisma.allergy.findMany({ where: { patientId, deletedAt: null } }),
    getPatient(patientId),
    prisma.appointment.count({ where: { patientId, status: 'COMPLETED', review: null } }),
  ]);
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
  // Profile completeness nudges the patient to add medical info
  const fields = ['phone', 'dateOfBirth', 'gender', 'bloodGroup', 'address', 'emergencyContactName', 'emergencyContactPhone'];
  const completeness = Math.round((fields.filter((f) => patient[f]).length / fields.length) * 100);
  return {
    upcoming, activeEmergency, recentPrescriptions: prescriptions, unreadNotifications: unread, allergies, pendingReviews,
    profileCompleteness: completeness,
    stats: {
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      upcoming: upcoming.length,
      completed: byStatus.COMPLETED || 0,
      cancelled: (byStatus.CANCELLED || 0) + (byStatus.REJECTED || 0),
      pending: byStatus.PENDING || 0,
    },
  };
}

// ── Profile ──
const getProfile = (patientId) => prisma.patient.findUnique({ where: { id: patientId }, include: { user: { select: { email: true, createdAt: true } } } });
const updateProfile = (patientId, { dateOfBirth, ...rest }) => prisma.patient.update({
  where: { id: patientId },
  data: { ...rest, ...(dateOfBirth !== undefined ? { dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null } : {}) },
});

// ── Allergies ──
const listAllergies = (patientId, deleted = false) => prisma.allergy.findMany({ where: { patientId, deletedAt: deleted ? { not: null } : null }, orderBy: { createdAt: 'desc' } });
const createAllergy = (patientId, data) => prisma.allergy.create({ data: { ...data, patientId } });
async function updateAllergy(patientId, id, data) {
  const existing = await prisma.allergy.findUnique({ where: { id } });
  if (!existing || existing.patientId !== patientId || existing.deletedAt) throw ApiError.notFound('Allergy not found');
  return prisma.allergy.update({ where: { id: existing.id }, data });
}
/** Soft delete: hidden from the patient and admins, kept (flagged) for treating clinicians; the patient can restore it */
async function deleteAllergy(actor, id) {
  if (!(await markDeleted('allergies', { id, patientId: actor.profileId }, actor))) throw ApiError.notFound('Allergy not found');
}
const restoreAllergy = (actor, id) => restoreOwn('allergies', id, actor);

// ── Reviews ──
const listReviews = (patientId, query) => paginateQuery(prisma.doctorReview, { where: { patientId }, include: { doctor: doctorNameAndSpecialty }, orderBy: { createdAt: 'desc' } }, query);

/** Reviews a completed appointment, once; the doctor is notified */
async function createReview(patientId, { appointmentId, rating, comment }) {
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId }, include: { review: true, doctor: { select: { userId: true, fullName: true } } } });
  if (!appt || appt.patientId !== patientId) throw ApiError.notFound('Appointment not found');
  if (appt.status !== 'COMPLETED') throw ApiError.badRequest('You can only review completed appointments');
  if (appt.review) throw ApiError.conflict('You have already reviewed this appointment');
  const review = await prisma.doctorReview.create({ data: { appointmentId: appt.id, doctorId: appt.doctorId, patientId, rating, comment: comment || null } });
  await notifyUser(appt.doctor.userId, { type: 'REVIEW', title: 'New patient review', message: `You received a ${review.rating}★ review${review.comment ? `: "${review.comment.slice(0, 100)}"` : '.'}`, link: '/doctor/reviews' });
  return review;
}

module.exports = { getPatient, dashboard, getProfile, updateProfile, listAllergies, createAllergy, updateAllergy, deleteAllergy, listReviews, createReview, restoreAllergy };
