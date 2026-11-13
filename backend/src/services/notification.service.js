const crypto = require('crypto');
const prisma = require('../config/prisma');
const { emitToUser } = require('../socket');
const { getPagination, paginated, stableOrder } = require('../utils/pagination');

/**
 * Stores one notification per user (no real-time push). `db` may be a transaction client, so the rows commit
 * together with the change they describe. Clients that were offline fetch them later from GET /notifications.
 */
async function createNotifications(db, userIds, data) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return [];
  return db.notification.createManyAndReturn({
    data: ids.map((userId) => ({
      userId,
      type: data.type || 'SYSTEM',
      title: data.title,
      message: data.message,
      link: data.link || null,
      broadcastId: data.broadcastId || null,
    })),
  });
}

/** Pushes already-stored notifications over Socket.IO (call only after they are committed) */
const emitNotifications = (rows) => rows.forEach((n) => emitToUser(n.userId, 'notification:new', n));

/**
 * Persists a notification for each user, then pushes it in real time over Socket.IO.
 * @param {string[]} userIds
 * @param {{type?:string,title:string,message:string,link?:string,broadcastId?:string}} data
 */
async function notifyUsers(userIds, data) {
  const rows = await createNotifications(prisma, userIds, data);
  emitNotifications(rows);
  return rows;
}

const notifyUser = (userId, data) => notifyUsers([userId], data);

async function notifyAdmins(data) {
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
  return notifyUsers(admins.map((a) => a.id), data);
}

// ── A user's own inbox ──
async function listForUser(userId, query) {
  const pg = getPagination(query);
  const where = { userId, ...(query.status === 'unread' ? { isRead: false } : {}), ...(query.type ? { type: query.type } : {}) };
  const [items, total, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: stableOrder({ createdAt: 'desc' }), skip: pg.skip, take: pg.take }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, isRead: false } }),
  ]);
  return { ...paginated(items, total, pg), unread };
}
const markRead = (userId, id) => prisma.notification.updateMany({ where: { id, userId }, data: { isRead: true, readAt: new Date() } });
const markAllRead = (userId) => prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true, readAt: new Date() } });
const removeForUser = (userId, id) => prisma.notification.deleteMany({ where: { id, userId } });

// ── Broadcasts (admin) ──
/** Sends a notification to every active user (or one role); returns { broadcastId, recipients } */
async function broadcast({ audience, title, message, type }) {
  const users = await prisma.user.findMany({ where: { isActive: true, ...(audience !== 'ALL' ? { role: audience } : {}) }, select: { id: true } });
  const broadcastId = crypto.randomUUID();
  const rows = await notifyUsers(users.map((u) => u.id), { type, title, message, broadcastId });
  return { broadcastId, recipients: rows.length };
}

/** Sent broadcasts (recorded in the audit log) with how many recipients have read each */
async function listBroadcasts() {
  const logs = await prisma.auditLog.findMany({ where: { action: 'NOTIFICATION_BROADCAST' }, orderBy: { createdAt: 'desc' }, take: 50, include: { user: { select: { email: true } } } });
  const ids = logs.map((l) => l.entityId).filter(Boolean);
  const readCounts = await prisma.notification.groupBy({ by: ['broadcastId'], where: { broadcastId: { in: ids }, isRead: true }, _count: { _all: true } });
  const readMap = Object.fromEntries(readCounts.map((r) => [r.broadcastId, r._count._all]));
  return logs.map((l) => ({ id: l.entityId, ...l.details, sentBy: l.user?.email, createdAt: l.createdAt, readCount: readMap[l.entityId] || 0 }));
}

/** Removes a broadcast from every inbox; returns how many notifications were removed */
const recallBroadcast = async (broadcastId) => (await prisma.notification.deleteMany({ where: { broadcastId } })).count;

module.exports = { createNotifications, emitNotifications, notifyUsers, notifyUser, notifyAdmins, listForUser, markRead, markAllRead, removeForUser, broadcast, listBroadcasts, recallBroadcast };
