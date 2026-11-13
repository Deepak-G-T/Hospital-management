// Complaints: from signed-in doctors/patients, from the public contact form, and the admin's responses.
const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { notifyAdmins, notifyUser } = require('./notification.service');
const { nameOnly, idAndName, userEmail } = require('../db/selects');
const { paginateQuery } = require('../utils/pagination');

const adminInclude = {
  complainant: { select: { id: true, email: true, role: true, doctor: nameOnly, patient: nameOnly } },
  againstDoctor: idAndName,
  respondedBy: userEmail,
};

const listForUser = (userId, query) => paginateQuery(prisma.complaint, {
  where: { complainantUserId: userId }, orderBy: { createdAt: 'desc' }, include: { againstDoctor: nameOnly },
}, query);

/** A doctor or patient files a complaint; admins are notified */
async function create(actor, data) {
  if (data.againstDoctorId) {
    if (actor.role === 'DOCTOR' && data.againstDoctorId === actor.profileId) throw ApiError.badRequest('Invalid doctor');
    if (!(await prisma.doctor.findUnique({ where: { id: data.againstDoctorId } }))) throw ApiError.notFound('Doctor not found');
  }
  const complaint = await prisma.complaint.create({ data: { ...data, complainantUserId: actor.id } });
  await notifyAdmins({ type: 'COMPLAINT', title: `New ${actor.role.toLowerCase()} complaint`, message: `${actor.fullName}: ${complaint.subject}`, link: '/admin/complaints' });
  return complaint;
}

/** A website visitor's contact message, stored as a guest complaint */
async function createContactMessage({ name, email, subject, message }) {
  const complaint = await prisma.complaint.create({ data: { guestName: name, guestEmail: email, subject, description: message, category: 'GENERAL_INQUIRY' } });
  await notifyAdmins({ type: 'COMPLAINT', title: 'New contact message', message: `${name}: ${subject}`, link: '/admin/complaints' });
  return complaint;
}

async function listForAdmin(query) {
  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.role === 'GUEST' ? { complainantUserId: null } : query.role ? { complainant: { role: query.role } } : {}),
  };
  return paginateQuery(prisma.complaint, { where, include: adminInclude, orderBy: { createdAt: 'desc' } }, query);
}

/** The admin's response; the complainant (if signed in) is notified */
async function respond(id, actor, { response, status }) {
  const complaint = await prisma.complaint.update({
    where: { id }, data: { response, status, respondedByUserId: actor.id, respondedAt: new Date() }, include: adminInclude,
  });
  if (complaint.complainantUserId) {
    const link = complaint.complainant.role === 'DOCTOR' ? '/doctor/complaints' : '/patient/complaints';
    await notifyUser(complaint.complainantUserId, { type: 'COMPLAINT', title: `Complaint ${status.toLowerCase().replace('_', ' ')}`, message: `Response to "${complaint.subject}": ${response.slice(0, 160)}`, link });
  }
  return complaint;
}

module.exports = { adminInclude, listForUser, create, createContactMessage, listForAdmin, respond };
