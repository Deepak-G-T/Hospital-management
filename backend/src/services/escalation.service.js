// Automatic emergency escalation — NOTIFICATION ONLY.
// When an emergency is not accepted within the target time for its priority, more people are alerted:
//   level 1: doctors of the emergency's department · level 2: emergency department · level 3: all emergency-available
//   doctors and all administrators.
// It never changes priority, never assigns a doctor, never accepts/resolves/cancels a case and never edits clinical data.
// Alerts are not a guarantee that someone responds, and this system does not replace real emergency services.
//
// Scheduling lives in PostgreSQL (emergency_requests.next_escalation_at, set with the database clock). Each API instance
// polls; a due case is claimed with SELECT … FOR UPDATE SKIP LOCKED inside a transaction, so only one instance can work on
// it. Everything for one escalation (notification rows, timeline event, escalation record, schedule) commits together,
// and the unique (emergency_id, level) index makes a retry or a concurrent run fail instead of escalating twice.
// A crash before commit rolls everything back; the case stays due and is picked up again. Socket.IO events are sent
// only after commit; clients that miss them load the stored notifications.
const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { config, targetMinutes, LEVELS } = require('../config/escalation');
const { createNotifications, emitNotifications } = require('./notification.service');
const { emitToDoctor } = require('../socket');
const { audit } = require('./audit.service');
const { OPEN_EMERGENCY_STATUSES } = require('../utils/constants');
const { emergencyRef } = require('../utils/emergencyRef');

// SQL list of the open statuses (PENDING, NOTIFIED, ESCALATED: no doctor has accepted yet). Built from constants only, never user input.
const OPEN = OPEN_EMERGENCY_STATUSES.map((v) => `'${v}'`).join(',');
const seconds = (priority) => Math.round(targetMinutes(priority) * 60 * 1000) / 1000;

// ── Scheduling (called by the emergency workflow) ──
/** New emergency: first escalation is due one target interval after it was created */
const scheduleFirst = (id, priority) => prisma.$executeRawUnsafe(
  `UPDATE emergency_requests SET next_escalation_at = created_at + make_interval(secs => $1::float8) WHERE id = $2::uuid AND auto_escalation_enabled AND auto_escalation_level = 0`,
  seconds(priority), id,
);

/**
 * The case is waiting for a doctor again (a doctor escalated it by hand, or an admin changed the priority): the next
 * automatic step is due one target interval (of the current priority) from now. Emergencies that existed before
 * automatic escalation (auto_escalation_enabled = false) are never scheduled.
 */
const restartClock = (id, priority) => prisma.$executeRawUnsafe(
  `UPDATE emergency_requests SET next_escalation_at = CASE WHEN auto_escalation_level < $1::int THEN now() + make_interval(secs => $2::float8) END
   WHERE id = $3::uuid AND auto_escalation_enabled AND status IN (${OPEN}) AND assigned_doctor_id IS NULL`,
  config.maxLevel, seconds(priority), id,
);

/**
 * Accepted, assigned, resolved or cancelled: no more automatic escalation. The workflow also clears next_escalation_at in
 * the same UPDATE that closes the case; the worker additionally re-checks status and assignment when it claims a row.
 */
const STOP = { nextEscalationAt: null };

// ── Acknowledgement ──
/**
 * "I have seen this emergency and assessment is in progress." Not acceptance, not assignment.
 * Pauses the next automatic escalation for one target interval; allowed once per escalation level, so it cannot
 * postpone escalation indefinitely. If nobody accepts, escalation resumes when the pause ends.
 * Doctors may acknowledge only emergencies they were alerted for; administrators may acknowledge any open one.
 */
async function acknowledge(actor, id) {
  const em = await prisma.emergencyRequest.findUnique({ where: { id }, select: { id: true, status: true, priority: true, autoEscalationLevel: true, acknowledgedLevel: true, assignedDoctorId: true } });
  if (!em) throw ApiError.notFound('Emergency not found');
  if (actor.role === 'DOCTOR') {
    const alerted = await prisma.emergencyNotification.findUnique({ where: { emergencyId_doctorId: { emergencyId: id, doctorId: actor.profileId } } });
    if (!alerted) throw ApiError.forbidden('You were not alerted for this emergency');
  } else if (actor.role !== 'ADMIN') throw ApiError.forbidden();
  if (!OPEN_EMERGENCY_STATUSES.includes(em.status) || em.assignedDoctorId) throw ApiError.conflict('This emergency has already been accepted or closed');

  // Conditional update: only one acknowledgement per level, even if two people press the button at the same time
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE emergency_requests
        SET acknowledged_at = now(), acknowledged_by_user_id = $1::uuid, acknowledged_level = auto_escalation_level,
            next_escalation_at = CASE WHEN next_escalation_at IS NOT NULL THEN now() + make_interval(secs => $2::float8) END
      WHERE id = $3::uuid AND status IN (${OPEN}) AND assigned_doctor_id IS NULL
        AND (acknowledged_level IS NULL OR acknowledged_level <> auto_escalation_level)
      RETURNING auto_escalation_level AS level, next_escalation_at AS "nextEscalationAt"`,
    actor.id, seconds(em.priority), id,
  );
  if (!rows.length) throw ApiError.conflict('This emergency has already been acknowledged at its current escalation level');
  if (actor.role === 'DOCTOR') {
    await prisma.emergencyNotification.updateMany({ where: { emergencyId: id, doctorId: actor.profileId, status: 'SENT' }, data: { status: 'SEEN' } });
  }
  const who = actor.role === 'ADMIN' ? `Admin ${actor.fullName}` : `Dr. ${actor.fullName}`;
  const pause = rows[0].nextEscalationAt ? ` Next automatic escalation paused until ${rows[0].nextEscalationAt.toISOString()} unless accepted.` : '';
  await prisma.emergencyEvent.create({ data: { emergencyId: id, eventType: 'ACKNOWLEDGED', message: `Acknowledged by ${who} — assessment in progress (not accepted).${pause}`, actorUserId: actor.id } });
  const { loadFull, broadcast } = require('./emergency.service');
  const full = await loadFull(id);
  broadcast(full);
  return { emergency: full, level: rows[0].level, nextEscalationAt: rows[0].nextEscalationAt };
}

// ── Who is alerted at each level ──
const doctorSelect = { id: true, userId: true };
const eligible = { isAvailableForEmergency: true, user: { isActive: true } };
async function recipientsFor(level, em, tx) {
  let doctors = [];
  if (level === 1) doctors = em.departmentId ? await tx.doctor.findMany({ where: { ...eligible, departments: { some: { departmentId: em.departmentId } } }, select: doctorSelect }) : [];
  if (level === 2) doctors = await tx.doctor.findMany({ where: { ...eligible, departments: { some: { department: { isEmergency: true, isActive: true } } } }, select: doctorSelect });
  if (level === 3) doctors = await tx.doctor.findMany({ where: eligible, select: doctorSelect });
  // Doctors who explicitly handed the case on (manual escalation) are not re-alerted
  const handedOn = new Set((await tx.emergencyNotification.findMany({ where: { emergencyId: em.id, status: 'ESCALATED' }, select: { doctorId: true } })).map((n) => n.doctorId));
  doctors = doctors.filter((d) => !handedOn.has(d.id));
  const admins = level === 3 ? await tx.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } }) : [];
  return { doctors, admins };
}

// Test-only fault injection (NODE_ENV=test): crash after all writes but before commit
const faultBeforeCommit = () => process.env.NODE_ENV === 'test' && process.env.ESCALATION_FAULT === 'crash-before-commit';

/**
 * Claims and escalates ONE due emergency. Returns null when nothing is due.
 * Safe to run concurrently from any number of API instances.
 */
async function escalateNextDue() {
  const result = await prisma.$transaction(async (tx) => {
    const [due] = await tx.$queryRawUnsafe(
      `SELECT id FROM emergency_requests
        WHERE next_escalation_at IS NOT NULL AND next_escalation_at <= now() AND auto_escalation_enabled
          AND status IN (${OPEN}) AND assigned_doctor_id IS NULL AND auto_escalation_level < $1::int
        ORDER BY next_escalation_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      config.maxLevel,
    );
    if (!due) return null;
    const em = await tx.emergencyRequest.findUnique({ where: { id: due.id }, select: { id: true, priority: true, status: true, departmentId: true, autoEscalationLevel: true, nextEscalationAt: true, notifiedAt: true } });
    const level = em.autoEscalationLevel + 1;
    const target = targetMinutes(em.priority);
    const { doctors, admins } = await recipientsFor(level, em, tx);

    if (doctors.length) await tx.emergencyNotification.createMany({ data: doctors.map((d) => ({ emergencyId: em.id, doctorId: d.id })), skipDuplicates: true });
    const title = `${em.priority} emergency — escalation level ${level}`;
    // generic text: no symptoms in stored notifications; the emergency board shows the case to authorised staff
    const message = `Not yet accepted after the ${target}-minute target. Alert widened to ${LEVELS[level].label}. Open the emergency board (ref ${emergencyRef(em.id)}).`;
    const doctorRows = await createNotifications(tx, doctors.map((d) => d.userId), { type: 'EMERGENCY', title, message, link: '/doctor/emergencies' });
    const adminRows = await createNotifications(tx, admins.map((a) => a.id), { type: 'EMERGENCY', title, message, link: '/admin/emergencies' });

    // Unique (emergency_id, level): a second attempt at the same level fails here and the whole transaction rolls back
    await tx.emergencyEscalation.create({
      data: {
        emergencyId: em.id, level, priority: em.priority, targetMinutes: target, dueAt: em.nextEscalationAt,
        notifiedUserIds: [...doctors.map((d) => d.userId), ...admins.map((a) => a.id)], notifiedDoctors: doctors.length, notifiedAdmins: admins.length,
      },
    });
    // Next step (or none after the last level). Priority, assignment and clinical fields are deliberately untouched.
    await tx.$executeRawUnsafe(
      `UPDATE emergency_requests
          SET auto_escalation_level = $1::int,
              next_escalation_at = CASE WHEN $1::int < $2::int THEN now() + make_interval(secs => $3::float8) END,
              status = CASE WHEN status = 'PENDING' AND $4::int > 0 THEN 'NOTIFIED'::"EmergencyStatus" ELSE status END,
              notified_at = CASE WHEN notified_at IS NULL AND $4::int > 0 THEN now() ELSE notified_at END,
              updated_at = now()
        WHERE id = $5::uuid AND auto_escalation_level = $6::int`,
      level, config.maxLevel, seconds(em.priority), doctors.length, em.id, em.autoEscalationLevel,
    );
    const reached = doctors.length || admins.length
      ? `alert sent to ${doctors.length} doctor(s)${admins.length ? ` and ${admins.length} administrator(s)` : ''}`
      : `no eligible recipients at this level${level < config.maxLevel ? ' — continuing to the next level' : ''}`;
    await tx.emergencyEvent.create({
      data: {
        emergencyId: em.id, eventType: 'AUTO_ESCALATED',
        message: `Automatic escalation level ${level} (${LEVELS[level].label}): not accepted within the ${target}-minute target; ${reached}. Priority unchanged (${em.priority}); no doctor assigned automatically.${level >= config.maxLevel ? ' Final automatic level reached — continued oversight by staff.' : ''}`,
      },
    });
    if (faultBeforeCommit()) process.exit(137);
    return { em, level, doctors, rows: [...doctorRows, ...adminRows] };
  }, { timeout: 20000 });

  if (!result) return null;
  // Committed — now tell connected clients (anyone offline gets the stored notifications on reconnect)
  emitNotifications(result.rows);
  result.doctors.forEach((d) => emitToDoctor(d.id, 'emergency:alert', { id: result.em.id, priority: result.em.priority, escalationLevel: result.level }));
  const { loadFull, broadcast } = require('./emergency.service');
  broadcast(await loadFull(result.em.id));
  audit(null, 'EMERGENCY_AUTO_ESCALATED', 'EmergencyRequest', result.em.id, { level: result.level, priority: result.em.priority, notifiedDoctors: result.doctors.length, notifiedTotal: result.rows.length });
  return { id: result.em.id, level: result.level };
}

/** Public view of the configuration (shown to admins) */
const describe = () => ({
  enabled: config.enabled, reason: config.reason, production: config.production, approvalRef: config.approvalRef,
  targetsMinutes: config.targets, maxLevel: config.maxLevel, pollSeconds: config.pollSeconds,
  levels: Object.fromEntries(Object.entries(LEVELS).filter(([l]) => Number(l) <= config.maxLevel).map(([l, v]) => [l, v.label])),
  note: 'Provisional operational targets pending hospital approval — not clinically validated response times. Escalation only notifies; it never changes priority or assigns a doctor.',
});

module.exports = { STOP, scheduleFirst, restartClock, acknowledge, escalateNextDue, describe };
