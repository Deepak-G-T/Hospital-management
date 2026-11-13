const { Server } = require('socket.io');
const prisma = require('../config/prisma');
const { verifyToken, issuedBeforePasswordChange } = require('../utils/token');
const { clientUrl } = require('../config/env');

let io = null;
const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout limit (~24.8 days)

function initSocket(httpServer) {
  io = new Server(httpServer, { cors: { origin: clientUrl, credentials: true } });

  // Authenticate every socket connection with the same JWT and account checks as the REST API
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('unauthorized'));
      const payload = verifyToken(token);
      const user = await prisma.user.findUnique({ where: { id: payload.sub }, include: { doctor: true, patient: true, admin: true } });
      if (!user || !user.isActive || issuedBeforePasswordChange(payload, user)) return next(new Error('unauthorized'));
      socket.data.user = { id: user.id, role: user.role, doctorId: user.doctor?.id, patientId: user.patient?.id, exp: payload.exp };
      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const u = socket.data.user;
    socket.join(`user:${u.id}`);
    socket.join(`role:${u.role}`);
    if (u.doctorId) socket.join(`doctor:${u.doctorId}`);
    if (u.patientId) socket.join(`patient:${u.patientId}`);

    // A live connection must not outlive its token: close it when the JWT expires.
    // The browser reconnects with its current token; an expired one is refused at the handshake.
    const expiresInMs = u.exp * 1000 - Date.now();
    const expiry = setTimeout(() => socket.disconnect(true), Math.max(0, Math.min(expiresInMs, MAX_TIMER_MS)));
    socket.on('disconnect', () => clearTimeout(expiry));
  });

  return io;
}

const emitToUser = (userId, event, payload) => io && io.to(`user:${userId}`).emit(event, payload);
const emitToUsers = (userIds, event, payload) => io && userIds.length && io.to(userIds.map((id) => `user:${id}`)).emit(event, payload);
const emitToRole = (role, event, payload) => io && io.to(`role:${role}`).emit(event, payload);
const emitToDoctor = (doctorId, event, payload) => io && io.to(`doctor:${doctorId}`).emit(event, payload);
/** Closes every live connection of a user (deactivation, deletion, password change/reset) */
const disconnectUser = (userId) => io && io.in(`user:${userId}`).disconnectSockets(true);

module.exports = { initSocket, emitToUser, emitToUsers, emitToRole, emitToDoctor, disconnectUser, getIO: () => io };
