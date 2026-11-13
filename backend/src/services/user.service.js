// User accounts: registration, sign-in lookups, passwords, and account administration.
const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { passwordChangeStamp } = require('../utils/token');
const { hashPassword, verifyPassword } = require('./password.service');
const { notifyAdmins, notifyUser } = require('./notification.service');
const loginThrottle = require('./loginThrottle');
const { disconnectUser } = require('../socket');
const { departmentRef } = require('../db/selects');
const { paginateQuery } = require('../utils/pagination');

/** The signed-in user as returned by /auth/me, /auth/login and /auth/register: account fields + `profile` */
async function loadSessionUser(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, role: true, isActive: true, lastLoginAt: true, createdAt: true,
      admin: true,
      doctor: { include: { departments: { include: { department: departmentRef } } } },
      patient: true,
    },
  });
  if (!user) return null;
  const { admin, doctor, patient, ...base } = user;
  return { ...base, profile: admin || doctor || patient };
}

/** Self-registration: creates a PATIENT account with its profile */
async function registerPatient({ email, password, fullName, phone, dateOfBirth, gender }) {
  const passwordHash = await hashPassword(password);
  const user = await prisma.$transaction(async (tx) => {
    if (await tx.user.findUnique({ where: { email } })) throw ApiError.conflict('An account with this email already exists');
    return tx.user.create({
      data: { email, passwordHash, role: 'PATIENT', patient: { create: { fullName, phone, gender, dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null } } },
    });
  });
  notifyAdmins({ type: 'SYSTEM', title: 'New patient registered', message: `${fullName} (${email}) created an account.`, link: '/admin/patients' }).catch(() => {});
  return user;
}

/** Looks up the account and checks the password: { user (or null), valid }. Timing does not reveal unknown emails. */
async function checkCredentials(email, password) {
  const user = await prisma.user.findUnique({ where: { email } });
  return { user, valid: await verifyPassword(password, user?.passwordHash) };
}

const recordLogin = (userId) => prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });

/** Changes the user's own password; every earlier session is invalidated and live sockets are closed */
async function changeOwnPassword(userId, currentPassword, newPassword) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!(await verifyPassword(currentPassword, user.passwordHash))) throw ApiError.badRequest('Current password is incorrect');
  const updated = await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: passwordChangeStamp() } });
  disconnectUser(user.id); // this browser reconnects with the renewed token; other devices are refused
  return updated;
}

// ── Administration ──
async function listUsers(query) {
  const search = query.search;
  const where = {
    ...(query.role ? { role: query.role } : {}),
    ...(query.status === 'active' ? { isActive: true } : query.status === 'inactive' ? { isActive: false } : {}),
    ...(search ? {
      OR: [
        { email: { contains: search, mode: 'insensitive' } },
        { doctor: { fullName: { contains: search, mode: 'insensitive' } } },
        { patient: { fullName: { contains: search, mode: 'insensitive' } } },
        { admin: { fullName: { contains: search, mode: 'insensitive' } } },
      ],
    } : {}),
  };
  return paginateQuery(prisma.user, {
    where, orderBy: { createdAt: 'desc' },
    select: {
      id: true, email: true, role: true, isActive: true, lastLoginAt: true, createdAt: true,
      admin: { select: { fullName: true } }, doctor: { select: { id: true, fullName: true } }, patient: { select: { id: true, fullName: true } },
    },
  }, query);
}

/** Activates/deactivates an account; deactivation closes the user's live connections */
async function setActive(actorId, userId, isActive) {
  if (userId === actorId) throw ApiError.badRequest('You cannot deactivate your own account');
  const user = await prisma.user.update({ where: { id: userId }, data: { isActive }, select: { id: true, email: true, isActive: true, role: true } });
  if (!user.isActive) disconnectUser(user.id); // REST calls already fail for inactive accounts; close live sockets too
  return user;
}

/** Admin password reset: ends all of the user's sessions and lifts any failed-login lock */
async function resetPassword(userId, newPassword) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: passwordChangeStamp() },
    select: { id: true, email: true },
  });
  disconnectUser(user.id);
  loginThrottle.clear(user.email);
  await notifyUser(user.id, { type: 'SYSTEM', title: 'Password reset', message: 'Your password was reset by an administrator. Please change it after logging in.' });
  return user;
}

module.exports = { loadSessionUser, registerPatient, checkCredentials, recordLogin, changeOwnPassword, listUsers, setActive, resetPassword };
