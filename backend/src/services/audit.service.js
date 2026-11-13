const prisma = require('../config/prisma');
const { getPagination, paginated, stableOrder } = require('../utils/pagination');
const { resolveRange, parseDateOnly, startOfDay, endOfDay } = require('../utils/dates');

// Builds the row for an audit entry from the request (or a request-like { user, ip, headers })
function auditData(req, action, entityType = null, entityId = null, details = null) {
  const user = req?.user;
  return {
    userId: user?.id || null,
    userRole: user?.role || null,
    action,
    entityType,
    entityId: entityId ? String(entityId) : null,
    details: details || undefined,
    // req.ip honours app.set('trust proxy', 1): behind Nginx it is the address Nginx saw, which a client cannot
    // forge (the raw X-Forwarded-For header, used before, can contain anything the client sends)
    ipAddress: req ? (req.ip || req.socket?.remoteAddress || null) : null,
    userAgent: req ? ((req.headers && req.headers['user-agent']) || '').slice(0, 500) : null,
  };
}

// Records an audit entry. Never throws — auditing must not break the main request.
function audit(req, action, entityType = null, entityId = null, details = null) {
  return prisma.auditLog
    .create({ data: auditData(req, action, entityType, entityId, details) })
    .catch((err) => console.error('[audit] failed:', err.message));
}

// Records an audit entry and REJECTS if it could not be written. Used before exceptional access to medical data is
// granted: if the access cannot be recorded, it does not happen.
const auditStrict = (req, action, entityType = null, entityId = null, details = null) => (
  prisma.auditLog.create({ data: auditData(req, action, entityType, entityId, details) })
);

/** Several strict entries at once (one query) */
const auditStrictMany = (req, entries) => prisma.auditLog.createMany({
  data: entries.map((e) => auditData(req, e.action, e.entityType, e.entityId, e.details)),
});

// ── Reading the audit log (admin) ──
// seq is a BigInt column (the hash chain position); JSON cannot carry BigInt, so it is sent as a number. The hashes stay in the
// database and are read by the verification script, not shown on screen.
const plain = ({ seq, prevHash, rowHash, ...row }) => ({ ...row, seq: Number(seq) }); // eslint-disable-line no-unused-vars
/** Audit log entries filtered by role, action (contains), entity type and dates, plus the list of distinct actions */
async function listLogs(q) {
  const pg = getPagination(q);
  const where = {
    ...(q.role ? { userRole: q.role } : {}),
    ...(q.action ? { action: { contains: q.action, mode: 'insensitive' } } : {}),
    ...(q.type ? { entityType: q.type } : {}),
  };
  if (q.from || q.to) {
    where.createdAt = {};
    if (q.from) where.createdAt.gte = startOfDay(parseDateOnly(q.from));
    if (q.to) where.createdAt.lte = endOfDay(parseDateOnly(q.to));
  }
  const [items, total, actions] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: stableOrder({ createdAt: 'desc' }), skip: pg.skip, take: pg.take, include: { user: { select: { email: true } } } }),
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
  ]);
  return { ...paginated(items.map(plain), total, pg), actions: actions.map((a) => a.action) };
}

/** Doctor and patient activity in a date range: the events, the most frequent actions and the most active users */
async function activity(q) {
  const pg = getPagination(q);
  const role = ['DOCTOR', 'PATIENT'].includes(q.role) ? q.role : undefined;
  const range = resolveRange(q, 7);
  const where = { userRole: role || { in: ['DOCTOR', 'PATIENT'] }, createdAt: { gte: range.from, lte: range.to } };
  const userNames = { email: true, doctor: { select: { fullName: true } }, patient: { select: { fullName: true } } };
  const [items, total, byAction, topUsers] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: stableOrder({ createdAt: 'desc' }), skip: pg.skip, take: pg.take, include: { user: { select: userNames } } }),
    prisma.auditLog.count({ where }),
    prisma.auditLog.groupBy({ by: ['action'], where, _count: { action: true }, orderBy: { _count: { action: 'desc' } }, take: 10 }),
    prisma.auditLog.groupBy({ by: ['userId'], where: { ...where, userId: { not: null } }, _count: { userId: true }, orderBy: { _count: { userId: 'desc' } }, take: 5 }),
  ]);
  const users = await prisma.user.findMany({ where: { id: { in: topUsers.map((u) => u.userId) } }, select: { id: true, role: true, ...userNames } });
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
  return {
    ...paginated(items.map(plain), total, pg),
    byAction: byAction.map((a) => ({ name: a.action, value: a._count.action })),
    mostActive: topUsers.map((u) => ({ ...userMap[u.userId], actions: u._count.userId })),
  };
}

module.exports = { audit, auditStrict, auditStrictMany, listLogs, activity };
