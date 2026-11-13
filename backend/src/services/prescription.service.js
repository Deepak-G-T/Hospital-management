// Digital prescriptions: issued by doctors, listed for doctors and patients, rendered as PDF.
const crypto = require('crypto');
const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { notifyUser } = require('./notification.service');
const { authorizeWrite, authorizeItem } = require('../policies/patientAccess');
const { doctorNameAndSpecialty } = require('../db/selects');
const { paginateQuery } = require('../utils/pagination');

/** A doctor with an active treatment relationship (or one linked to their own appointment) issues a prescription */
async function create(actor, { patientId, appointmentId, items, followUpDate, ...rest }) {
  await authorizeWrite(actor, patientId, { appointmentId }, 'PRESCRIPTION_WRITE');
  if (appointmentId) {
    const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
    if (!appt || appt.doctorId !== actor.profileId || appt.patientId !== patientId) throw ApiError.badRequest('Invalid appointment for this prescription');
  }
  const number = `RX-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const rx = await prisma.prescription.create({
    data: {
      ...rest, prescriptionNumber: number, patientId, appointmentId: appointmentId || null, doctorId: actor.profileId,
      followUpDate: followUpDate ? new Date(followUpDate) : null,
      items: { create: items },
    },
    include: { items: true, patient: { select: { fullName: true, userId: true } } },
  });
  await notifyUser(rx.patient.userId, { type: 'PRESCRIPTION', title: 'New prescription', message: `Dr. ${actor.fullName} issued prescription ${rx.prescriptionNumber}.`, link: '/patient/prescriptions' });
  return rx;
}

async function listForDoctor(doctorId, query) {
  const where = { doctorId, ...(query.search ? { patient: { fullName: { contains: query.search, mode: 'insensitive' } } } : {}) };
  return paginateQuery(prisma.prescription, { where, include: { items: true, patient: { select: { id: true, fullName: true } } }, orderBy: { createdAt: 'desc' } }, query);
}

const listForPatient = (patientId, query) => paginateQuery(prisma.prescription, {
  where: { patientId }, orderBy: { createdAt: 'desc' },
  include: { items: true, doctor: doctorNameAndSpecialty, appointment: { select: { startAt: true } } },
}, query);

/** Everything the PDF needs, after the access check (the issuing doctor always has access; an admin needs a reason) */
async function getForPdf(user, id) {
  const rx = await prisma.prescription.findUnique({
    where: { id },
    include: {
      items: { orderBy: { createdAt: 'asc' } },
      doctor: { select: { id: true, fullName: true, specialization: true, qualification: true, licenseNumber: true } },
      patient: { select: { id: true, fullName: true, dateOfBirth: true, gender: true, bloodGroup: true, allergies: { where: { deletedAt: null }, select: { allergen: true, severity: true } } } },
    },
  });
  if (!rx) throw ApiError.notFound('Prescription not found');
  await authorizeItem(user, { kind: 'PRESCRIPTION', id: rx.id, patientId: rx.patientId, appointmentId: rx.appointmentId, doctorId: rx.doctorId });
  return rx;
}

module.exports = { create, listForDoctor, listForPatient, getForPdf };
