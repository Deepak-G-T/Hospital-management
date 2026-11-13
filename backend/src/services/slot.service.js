const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { parseDateOnly, combineDateTime, toMinutes, startOfDay, endOfDay, formatDateKey } = require('../utils/dates');
const { ACTIVE_APPOINTMENT_STATUSES } = require('../utils/constants');

const MAX_BOOKING_DAYS_AHEAD = 90;

/**
 * Builds all bookable slots for a doctor on a given date from their weekly availability,
 * marking slots that are already booked or in the past as unavailable.
 */
async function getDoctorSlots(doctorId, dateStr, { excludeAppointmentId } = {}) {
  const date = parseDateOnly(dateStr);
  if (!date) throw ApiError.badRequest('Invalid date');

  const doctor = await prisma.doctor.findUnique({
    where: { id: doctorId },
    include: { availability: { where: { dayOfWeek: date.getDay(), isActive: true }, orderBy: { startTime: 'asc' } }, user: { select: { isActive: true } } },
  });
  if (!doctor || !doctor.user.isActive) throw ApiError.notFound('Doctor not found');

  const booked = await prisma.appointment.findMany({
    where: {
      doctorId,
      status: { in: ACTIVE_APPOINTMENT_STATUSES },
      startAt: { gte: startOfDay(date), lte: endOfDay(date) },
      ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
    },
    select: { startAt: true },
  });
  const bookedSet = new Set(booked.map((b) => b.startAt.getTime()));
  const now = Date.now();
  const duration = doctor.slotDurationMinutes;

  const slots = [];
  for (const block of doctor.availability) {
    for (let m = toMinutes(block.startTime); m + duration <= toMinutes(block.endTime); m += duration) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      const startAt = combineDateTime(formatDateKey(date), `${hh}:${mm}`);
      const endAt = new Date(startAt.getTime() + duration * 60000);
      const isBooked = bookedSet.has(startAt.getTime());
      const isPast = startAt.getTime() <= now;
      slots.push({ time: `${hh}:${mm}`, startAt, endAt, available: !isBooked && !isPast, booked: isBooked });
    }
  }
  return { doctorId, date: formatDateKey(date), slotDurationMinutes: duration, slots };
}

/** Ensures the requested start time is a real, future slot within the doctor's hours. Returns endAt. */
async function assertValidSlot(doctorId, startAt) {
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) throw ApiError.badRequest('Invalid appointment time');
  if (start.getTime() <= Date.now()) throw ApiError.badRequest('Appointment time must be in the future');
  if (start.getTime() > Date.now() + MAX_BOOKING_DAYS_AHEAD * 86400000) {
    throw ApiError.badRequest(`Appointments can be booked up to ${MAX_BOOKING_DAYS_AHEAD} days ahead`);
  }
  const { slots } = await getDoctorSlots(doctorId, formatDateKey(start));
  const slot = slots.find((s) => s.startAt.getTime() === start.getTime());
  if (!slot) throw ApiError.badRequest('Selected time is outside the doctor\'s consultation hours');
  return slot.endAt;
}

module.exports = { getDoctorSlots, assertValidSlot };
