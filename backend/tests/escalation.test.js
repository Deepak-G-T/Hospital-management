/* eslint-disable no-console */
// P1 item 6 — automatic emergency escalation.
// Starts its OWN API instances (fast provisional targets) against a disposable *_test database, so no other API may
// be running against that database while this suite runs (it would claim escalations too).
//   DATABASE_URL=…/smart_hospital_test npm run test:escalation
// Covers: all four priorities, every level and its recipients, priority/assignment never changed automatically,
// acknowledgement (pause, once per level, resume), doctor acceptance, resolution and cancellation stop escalation,
// several API instances without duplicates, a crash before commit and recovery, production mode disabled,
// unauthorized acknowledgement, audited manual priority changes, notifications persisted before Socket.IO and
// retrievable by clients that were offline.
require('dotenv').config({ quiet: true });
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const { PrismaClient } = require('@prisma/client');
const { loadEscalationConfig } = require('../src/config/escalation');

const DB_URL = process.env.DATABASE_URL || '';
if (!/_test(\?|$)/.test(DB_URL)) { console.log('Skipped: set DATABASE_URL to a disposable *_test database'); process.exit(0); }
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

// Fast targets for the test only: 1.2s / 2.4s / 3.6s / 4.8s
const TARGETS = { CRITICAL: 0.02, HIGH: 0.04, MEDIUM: 0.06, LOW: 0.08 };
const TARGETS_ENV = Object.entries(TARGETS).map(([k, v]) => `${k}=${v}`).join(',');
const secs = (p) => TARGETS[p] * 60;
const PROD_SECRET = crypto.randomBytes(32).toString('hex'); // test-only secret for the production-mode instances
const BACKEND = path.join(__dirname, '..');

let passed = 0; let failed = 0;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(`  ✔ ${name}`); console.log(`  ✔ ${name}`); } catch (e) { failed += 1; results.push(`  ✘ ${name}\n      ${e.stack.split('\n').slice(0, 3).join('\n      ')}`); console.log(`  ✘ ${name}: ${e.message}`); }
}
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms}ms waiting for ${label}`);
    await sleep(100);
  }
}

// ── API instances ──
const instances = new Set();
const allLogs = []; // every instance's output, checked for unexpected errors at the end
function startApi(name, port, extraEnv = {}, { removeEnv = [] } = {}) {
  const env = { ...process.env, DATABASE_URL: DB_URL, PORT: String(port), NODE_ENV: 'test', ESCALATION_TARGETS: TARGETS_ENV, ESCALATION_POLL_SECONDS: '0.2', ...extraEnv };
  for (const k of ['ESCALATION_ENABLED', 'ESCALATION_APPROVAL_REF', 'ESCALATION_FAULT', 'ESCALATION_MAX_LEVEL', ...removeEnv]) if (!(k in extraEnv)) delete env[k];
  const proc = spawn(process.execPath, ['src/server.js', `escalation-test-${name}`], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const inst = { name, port, proc, log: '', api: `http://localhost:${port}/api`, base: `http://localhost:${port}`, exitCode: undefined };
  proc.stdout.on('data', (d) => { inst.log += d; });
  proc.stderr.on('data', (d) => { inst.log += d; });
  inst.exited = new Promise((r) => proc.on('exit', (code, signal) => { inst.exitCode = code ?? signal; instances.delete(inst); allLogs.push(inst.log); r(inst.exitCode); }));
  instances.add(inst);
  return inst;
}
async function ready(inst) {
  await waitFor(async () => {
    if (inst.exitCode !== undefined) throw new Error(`${inst.name} exited (${inst.exitCode}): ${inst.log}`);
    try { return (await fetch(`${inst.api}/health`)).ok; } catch { return false; }
  }, 15000, `${inst.name} to start`);
  return inst;
}
async function stopApi(inst) {
  if (inst.exitCode !== undefined) return;
  inst.proc.kill('SIGTERM');
  await Promise.race([inst.exited, sleep(5000).then(() => inst.proc.kill('SIGKILL'))]);
  await inst.exited;
}
process.on('exit', () => { for (const i of instances) try { i.proc.kill('SIGKILL'); } catch { /* gone */ } });

async function req(inst, method, p, { token, body } = {}) {
  const h = {};
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(inst.api + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function login(inst, email, password) {
  const r = await req(inst, 'POST', '/auth/login', { body: { email, password } });
  assert.strictEqual(r.status, 200, `login ${email}: ${JSON.stringify(r.body)}`);
  return { token: r.body.token, user: r.body.user };
}
let patientSeq = 0;
async function newPatient(inst) {
  patientSeq += 1;
  const email = `esc.${Date.now()}.${patientSeq}@example.com`;
  const r = await req(inst, 'POST', '/auth/register', { body: { email, password: 'Start@1234', fullName: `Escalation Test ${patientSeq}` } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.token, user: r.body.user };
}
const tag = () => `ESC-${crypto.randomBytes(4).toString('hex')}`;
async function createEmergency(inst, priority, departmentId, label = tag()) {
  const patient = await newPatient(inst);
  const r = await req(inst, 'POST', '/patient/emergencies', { token: patient.token, body: { priority, departmentId, symptoms: `Test case ${label} — synthetic, not a real patient` } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  // notifications no longer repeat symptoms; they carry a short non-clinical reference instead (ref <first 8 chars of the id>)
  return { id: r.body.data.id, patient, tag: r.body.data.id.slice(0, 8), priority };
}
const row = (id) => db.emergencyRequest.findUnique({ where: { id } });
const escalations = (id) => db.emergencyEscalation.findMany({ where: { emergencyId: id }, orderBy: { level: 'asc' } });
const eventsOf = (id, eventType) => db.emergencyEvent.findMany({ where: { emergencyId: id, eventType }, orderBy: { createdAt: 'asc' } });
const levelReached = (id, level) => async () => (await row(id)).autoEscalationLevel >= level;
const sameSet = (a, b, msg) => assert.deepStrictEqual([...new Set(a)].sort(), [...new Set(b)].sort(), msg);

/** Expected recipients, written independently of the service (plain SQL) */
async function expectedRecipients(level, em) {
  const handedOn = `AND d.id NOT IN (SELECT doctor_id FROM emergency_notifications WHERE emergency_id = '${em.id}'::uuid AND status = 'ESCALATED')`;
  const eligible = `d.is_available_for_emergency AND u.is_active ${handedOn}`;
  let doctors = [];
  if (level === 1) doctors = await db.$queryRawUnsafe(`SELECT DISTINCT d.user_id FROM doctors d JOIN users u ON u.id = d.user_id JOIN doctor_departments dd ON dd.doctor_id = d.id WHERE dd.department_id = '${em.departmentId}'::uuid AND ${eligible}`);
  if (level === 2) doctors = await db.$queryRawUnsafe(`SELECT DISTINCT d.user_id FROM doctors d JOIN users u ON u.id = d.user_id JOIN doctor_departments dd ON dd.doctor_id = d.id JOIN departments dep ON dep.id = dd.department_id WHERE dep.is_emergency AND dep.is_active AND ${eligible}`);
  if (level === 3) doctors = await db.$queryRawUnsafe(`SELECT d.user_id FROM doctors d JOIN users u ON u.id = d.user_id WHERE ${eligible}`);
  const admins = level === 3 ? await db.$queryRawUnsafe(`SELECT id AS user_id FROM users WHERE role = 'ADMIN' AND is_active`) : [];
  return { doctors: doctors.map((r) => r.user_id), admins: admins.map((r) => r.user_id) };
}

(async () => {
  // ── Configuration rules (no API needed) ──
  await test('config: ON by default in development and test, OFF by default in production', async () => {
    assert.strictEqual(loadEscalationConfig({ NODE_ENV: 'development' }).enabled, true);
    assert.strictEqual(loadEscalationConfig({ NODE_ENV: 'test' }).enabled, true);
    assert.strictEqual(loadEscalationConfig({}).enabled, true, 'no NODE_ENV = development');
    const prod = loadEscalationConfig({ NODE_ENV: 'production' });
    assert.strictEqual(prod.enabled, false); assert.match(prod.reason, /off by default in production/);
  });
  await test('config: production needs ESCALATION_ENABLED=true AND an approval reference', async () => {
    const noRef = loadEscalationConfig({ NODE_ENV: 'production', ESCALATION_ENABLED: 'true' });
    assert.strictEqual(noRef.enabled, false); assert.strictEqual(noRef.productionBlocked, true); assert.match(noRef.reason, /APPROVAL_REF/);
    const blankRef = loadEscalationConfig({ NODE_ENV: 'production', ESCALATION_ENABLED: 'true', ESCALATION_APPROVAL_REF: '   ' });
    assert.strictEqual(blankRef.enabled, false);
    const ok = loadEscalationConfig({ NODE_ENV: 'production', ESCALATION_ENABLED: 'true', ESCALATION_APPROVAL_REF: 'Governance 2026-11-12 item 4' });
    assert.strictEqual(ok.enabled, true); assert.strictEqual(ok.approvalRef, 'Governance 2026-11-12 item 4');
    assert.strictEqual(loadEscalationConfig({ NODE_ENV: 'production', ESCALATION_APPROVAL_REF: 'x' }).enabled, false, 'a reference alone does not enable it');
    assert.strictEqual(loadEscalationConfig({ NODE_ENV: 'development', ESCALATION_ENABLED: 'false' }).enabled, false);
  });
  await test('config: provisional default targets 2/5/15/30 min, overrides validated, max level 1–3', async () => {
    assert.deepStrictEqual(loadEscalationConfig({}).targets, { CRITICAL: 2, HIGH: 5, MEDIUM: 15, LOW: 30 });
    assert.deepStrictEqual(loadEscalationConfig({ ESCALATION_TARGETS: 'critical=1, LOW=45' }).targets, { CRITICAL: 1, HIGH: 5, MEDIUM: 15, LOW: 45 });
    assert.throws(() => loadEscalationConfig({ ESCALATION_TARGETS: 'URGENT=1' }), /Invalid ESCALATION_TARGETS/);
    assert.throws(() => loadEscalationConfig({ ESCALATION_TARGETS: 'HIGH=0' }), /Invalid ESCALATION_TARGETS/);
    assert.strictEqual(loadEscalationConfig({ ESCALATION_MAX_LEVEL: '9' }).maxLevel, 3);
    assert.strictEqual(loadEscalationConfig({ ESCALATION_MAX_LEVEL: '1' }).maxLevel, 1);
  });

  // ── Fixtures from the seeded test database ──
  const cardiology = await db.department.findFirst({ where: { name: 'Cardiology' } });
  assert.ok(cardiology, 'seeded Cardiology department');
  const emergencyIdsBefore = new Set((await db.emergencyRequest.findMany({ select: { id: true } })).map((e) => e.id));
  const doctorUser = async (where) => db.doctor.findFirst({ where, include: { user: true } });
  // Non-critical emergencies alert only doctors who are ON SHIFT right now (same rule as emergency.service), or everyone in the
  // department when nobody is. Pick a Cardiology doctor who will really be alerted, so the test does not depend on the time of day.
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const nowD = new Date(); const nowMin = nowD.getHours() * 60 + nowD.getMinutes();
  const cardioCandidates = await db.doctor.findMany({ where: { isAvailableForEmergency: true, user: { isActive: true }, departments: { some: { departmentId: cardiology.id } } }, include: { user: true, availability: true }, orderBy: { id: 'asc' } });
  const onShiftNow = (d) => d.availability.some((a) => a.isActive && a.dayOfWeek === nowD.getDay() && toMin(a.startTime) <= nowMin && nowMin < toMin(a.endTime));
  const cardioDoctor = cardioCandidates.find(onShiftNow) || cardioCandidates[0];
  const edDoctor = await doctorUser({ isAvailableForEmergency: true, user: { isActive: true }, departments: { some: { department: { isEmergency: true } } }, NOT: { departments: { some: { departmentId: cardiology.id } } } });
  const unavailableDoctor = await doctorUser({ isAvailableForEmergency: false, user: { isActive: true } });
  assert.ok(cardioDoctor && edDoctor && unavailableDoctor, 'seeded doctors for each role in the test');

  // ── Phase 1: one API instance ──
  const A = await ready(startApi('A', 5011));
  const admin = await login(A, 'admin@medicore.com', 'Admin@123');
  const cardio = await login(A, cardioDoctor.user.email, 'Doctor@123');
  const unavailable = await login(A, unavailableDoctor.user.email, 'Doctor@123');

  await test('worker starts with the provisional targets and logs it', async () => {
    await waitFor(() => /automatic emergency escalation is ON/.test(A.log), 3000, 'ON log line');
    const cfg = await req(A, 'GET', '/admin/escalation-config', { token: admin.token });
    assert.strictEqual(cfg.status, 200);
    assert.strictEqual(cfg.body.data.enabled, true);
    assert.deepStrictEqual(cfg.body.data.targetsMinutes, TARGETS);
    assert.match(cfg.body.data.note, /not clinically validated/);
    assert.strictEqual((await req(A, 'GET', '/admin/escalation-config', { token: cardio.token })).status, 403, 'admin only');
  });

  // Live sockets: one Cardiology doctor and the admin are connected; the ED doctor is offline the whole time
  const live = [];
  const connect = (token) => new Promise((resolve, reject) => {
    const s = io(A.base, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    s.once('connect', () => resolve(s)); s.once('connect_error', reject);
  });
  const cardioSocket = await connect(cardio.token);
  const adminSocket = await connect(admin.token);
  const persistedAtEmit = [];
  for (const [who, s] of [['doctor', cardioSocket], ['admin', adminSocket]]) {
    s.on('notification:new', async (n) => {
      live.push({ who, event: 'notification:new', n });
      // Persist-before-emit: the row must already be committed when the event arrives
      persistedAtEmit.push(Boolean(await db.notification.findUnique({ where: { id: n.id } })));
    });
    s.on('emergency:alert', (p) => live.push({ who, event: 'emergency:alert', p }));
  }

  // All four priorities, escalated through all three levels
  const cases = {};
  for (const p of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) cases[p] = await createEmergency(A, p, cardiology.id);

  await test('each new emergency is scheduled one target interval after creation (DB clock) and the timeline says so', async () => {
    for (const p of Object.keys(cases)) {
      const em = await row(cases[p].id);
      assert.strictEqual(em.autoEscalationEnabled, true);
      assert.ok(em.nextEscalationAt, `${p} scheduled`);
      const delta = (em.nextEscalationAt - em.createdAt) / 1000;
      assert.ok(Math.abs(delta - secs(p)) < 0.01, `${p}: first escalation ${delta}s after creation, expected ${secs(p)}s`);
      const [ev] = await eventsOf(em.id, 'ESCALATION_SCHEDULED');
      assert.ok(ev && /Priority is never changed automatically/.test(ev.message), 'scheduling recorded in timeline');
    }
  });

  await waitFor(async () => (await Promise.all(Object.values(cases).map((c) => levelReached(c.id, 3)()))).every(Boolean), 30000, 'all four priorities to reach level 3');
  await sleep(1500); // give a (wrong) fourth level the chance to appear

  await test('all four priorities escalate through levels 1→2→3 at their own target intervals, then stop', async () => {
    for (const p of Object.keys(cases)) {
      const em = await row(cases[p].id);
      const rows = await escalations(em.id);
      assert.deepStrictEqual(rows.map((r) => r.level), [1, 2, 3], `${p} levels`);
      assert.strictEqual(em.autoEscalationLevel, 3);
      assert.strictEqual(em.nextEscalationAt, null, `${p}: nothing scheduled after the final level`);
      let prev = em.createdAt;
      for (const r of rows) {
        assert.strictEqual(r.priority, p); assert.strictEqual(r.targetMinutes, TARGETS[p]);
        const gap = (r.createdAt - prev) / 1000;
        assert.ok(gap >= secs(p) - 0.05, `${p} level ${r.level} came ${gap}s after the previous step (target ${secs(p)}s) — too early`);
        assert.ok(gap < secs(p) + 2, `${p} level ${r.level} came ${gap}s after the previous step — too late`);
        assert.ok(r.createdAt >= r.dueAt, 'never before it was due');
        prev = r.createdAt;
      }
      assert.strictEqual((await eventsOf(em.id, 'AUTO_ESCALATED')).length, 3, `${p}: every escalation is on the timeline`);
    }
    const firstAt = async (p) => (await escalations(cases[p].id))[0].createdAt;
    assert.ok(await firstAt('CRITICAL') < await firstAt('HIGH') && await firstAt('HIGH') < await firstAt('MEDIUM') && await firstAt('MEDIUM') < await firstAt('LOW'), 'shorter targets escalate first');
  });

  await test('automatic escalation never changes priority, never assigns, never accepts/resolves', async () => {
    for (const p of Object.keys(cases)) {
      const em = await row(cases[p].id);
      assert.strictEqual(em.priority, p, 'priority unchanged');
      assert.strictEqual(em.assignedDoctorId, null, 'no doctor assigned');
      assert.strictEqual(em.acceptedAt, null); assert.strictEqual(em.resolvedAt, null);
      assert.ok(['NOTIFIED', 'PENDING'].includes(em.status), `status stays open (${em.status})`);
      assert.strictEqual(em.escalationLevel, 0, 'the manual escalation level is untouched');
      for (const ev of await eventsOf(em.id, 'AUTO_ESCALATED')) {
        assert.strictEqual(ev.actorUserId, null, 'system event');
        assert.match(ev.message, new RegExp(`Priority unchanged \\(${p}\\); no doctor assigned automatically`));
      }
    }
  });

  await test('levels alert the right people: 1 department doctors, 2 emergency department, 3 all available doctors + admins', async () => {
    for (const p of Object.keys(cases)) {
      const em = await row(cases[p].id);
      for (const r of await escalations(em.id)) {
        const exp = await expectedRecipients(r.level, em);
        sameSet(r.notifiedUserIds, [...exp.doctors, ...exp.admins], `${p} level ${r.level} recipients`);
        assert.strictEqual(r.notifiedDoctors, exp.doctors.length); assert.strictEqual(r.notifiedAdmins, exp.admins.length);
        assert.strictEqual(r.notifiedAdmins > 0, r.level === 3, 'administrators only at level 3');
        // Each recipient has exactly one stored notification for this level
        const notes = await db.notification.findMany({ where: { title: `${p} emergency — escalation level ${r.level}`, message: { contains: cases[p].tag } } });
        sameSet(notes.map((n) => n.userId), r.notifiedUserIds, 'stored notifications match recipients');
        assert.strictEqual(notes.length, r.notifiedUserIds.length, 'no duplicate notifications');
      }
      assert.ok((await escalations(em.id))[0].notifiedUserIds.includes(cardioDoctor.userId), 'department doctor alerted at level 1');
      assert.ok((await escalations(em.id))[1].notifiedUserIds.includes(edDoctor.userId), 'ED doctor alerted at level 2');
    }
    // Doctors alerted by escalation can see the case on their board
    const edLogin = await login(A, edDoctor.user.email, 'Doctor@123');
    const board = await req(A, 'GET', '/doctor/emergencies?scope=active', { token: edLogin.token });
    assert.ok(Object.values(cases).every((c) => board.body.data.some((e) => e.id === c.id)), 'ED doctor sees escalated cases');
    // Unavailable doctors are never alerted
    for (const c of Object.values(cases)) for (const r of await escalations(c.id)) assert.ok(!r.notifiedUserIds.includes(unavailableDoctor.userId));
  });

  await test('notifications are stored before the Socket.IO push; live clients get them with the escalation level', async () => {
    const pushed = live.filter((l) => l.event === 'notification:new' && /escalation level/.test(l.n.title));
    assert.ok(pushed.some((l) => l.who === 'doctor') && pushed.some((l) => l.who === 'admin' && /level 3/.test(l.n.title)), 'doctor and admin received pushes');
    await waitFor(() => persistedAtEmit.length >= live.filter((l) => l.event === 'notification:new').length, 2000, 'persistence checks');
    assert.ok(persistedAtEmit.length > 0 && persistedAtEmit.every(Boolean), 'every pushed notification was already in the database');
    const alerts = live.filter((l) => l.event === 'emergency:alert' && l.p.escalationLevel);
    assert.ok(alerts.some((a) => a.p.id === cases.CRITICAL.id && a.p.escalationLevel === 1), 'emergency:alert carries the level');
    // privacy: no symptoms anywhere in the pushed or stored escalation notifications, and the alert payload has no clinical text
    for (const l of live) {
      if (l.event === 'emergency:alert') assert.ok(!('symptoms' in l.p) && !JSON.stringify(l.p).includes('Test case'), 'alert payload without symptoms');
      if (l.event === 'notification:new') assert.ok(!/Test case|synthetic/i.test(JSON.stringify(l.n)), 'pushed notification without symptoms');
    }
    const stored = await db.notification.findMany({ where: { title: { contains: 'escalation level' }, createdAt: { gte: new Date(Date.now() - 600000) } } });
    assert.ok(stored.length > 0 && stored.every((n) => !/Test case|synthetic/i.test(n.message) && /\(ref [0-9a-f]{8}\)/.test(n.message)), 'stored escalation notifications are generic with a short reference');
  });

  await test('a client that was offline retrieves the missed escalation notifications on reconnect (GET /notifications)', async () => {
    const ed = await login(A, edDoctor.user.email, 'Doctor@123'); // never had a socket open
    const r = await req(A, 'GET', '/notifications?status=unread&limit=100', { token: ed.token });
    assert.strictEqual(r.status, 200);
    for (const c of Object.values(cases)) {
      const mine = r.body.data.items.filter((n) => n.message.includes(c.tag) && /escalation level/.test(n.title));
      assert.deepStrictEqual(mine.map((n) => n.title).sort(), [`${c.priority} emergency — escalation level 2`, `${c.priority} emergency — escalation level 3`], `${c.priority}: levels 2 and 3 waiting in the inbox`);
    }
    assert.ok(r.body.data.unread > 0);
  });

  // ── Acknowledgement ──
  await test('unauthorized acknowledgement is refused (401 / 403 / 404 / 400) and changes nothing', async () => {
    const c = await createEmergency(A, 'LOW', cardiology.id);
    const before = await row(c.id);
    assert.strictEqual((await req(A, 'POST', `/doctor/emergencies/${c.id}/acknowledge`)).status, 401, 'no token');
    assert.strictEqual((await req(A, 'POST', `/doctor/emergencies/${c.id}/acknowledge`, { token: c.patient.token })).status, 403, 'patient (doctor route)');
    assert.strictEqual((await req(A, 'POST', `/admin/emergencies/${c.id}/acknowledge`, { token: c.patient.token })).status, 403, 'patient (admin route)');
    assert.strictEqual((await req(A, 'POST', `/admin/emergencies/${c.id}/acknowledge`, { token: cardio.token })).status, 403, 'doctor on the admin route');
    const notAlerted = await req(A, 'POST', `/doctor/emergencies/${c.id}/acknowledge`, { token: unavailable.token });
    assert.strictEqual(notAlerted.status, 403, 'doctor who was not alerted'); assert.match(notAlerted.body.message, /not alerted/);
    assert.strictEqual((await req(A, 'POST', `/admin/emergencies/${crypto.randomUUID()}/acknowledge`, { token: admin.token })).status, 404, 'unknown emergency');
    assert.strictEqual((await req(A, 'POST', '/admin/emergencies/not-a-uuid/acknowledge', { token: admin.token })).status, 400, 'invalid id');
    const after = await row(c.id);
    assert.strictEqual(after.acknowledgedAt, null); assert.deepStrictEqual(after.nextEscalationAt, before.nextEscalationAt, 'schedule untouched');
    await req(A, 'POST', `/admin/emergencies/${c.id}/resolve`, { token: admin.token, body: { notes: 'test cleanup' } });
    const closed = await req(A, 'POST', `/admin/emergencies/${c.id}/acknowledge`, { token: admin.token });
    assert.strictEqual(closed.status, 409, 'closed emergency');
  });

  await test('acknowledgement: records who/when, is not acceptance, pauses one target interval, once per level, then escalation resumes', async () => {
    const c = await createEmergency(A, 'MEDIUM', cardiology.id); // 3.6 s target
    const alerted = await db.emergencyNotification.findFirst({ where: { emergencyId: c.id, doctorId: cardioDoctor.id } });
    assert.ok(alerted, 'the Cardiology doctor was alerted on creation');
    const original = (await row(c.id)).nextEscalationAt;
    await sleep(800);
    const ack = await req(A, 'POST', `/doctor/emergencies/${c.id}/acknowledge`, { token: cardio.token });
    assert.strictEqual(ack.status, 200, JSON.stringify(ack.body));
    let em = await row(c.id);
    assert.strictEqual(em.acknowledgedByUserId, cardioDoctor.userId); assert.ok(em.acknowledgedAt); assert.strictEqual(em.acknowledgedLevel, 0);
    assert.strictEqual(em.status, 'NOTIFIED', 'not accepted'); assert.strictEqual(em.assignedDoctorId, null, 'not assigned'); assert.strictEqual(em.priority, 'MEDIUM');
    const pause = (em.nextEscalationAt - em.acknowledgedAt) / 1000;
    assert.ok(Math.abs(pause - secs('MEDIUM')) < 0.01, `paused for one target interval (${pause}s)`);
    assert.ok(em.nextEscalationAt > original, 'next escalation moved later');
    assert.strictEqual(ack.body.data.acknowledgedBy.email, cardioDoctor.user.email, 'response includes who acknowledged');
    assert.strictEqual((await db.emergencyNotification.findFirst({ where: { emergencyId: c.id, doctorId: cardioDoctor.id } })).status, 'SEEN');
    const [ev] = await eventsOf(c.id, 'ACKNOWLEDGED');
    assert.match(ev.message, /assessment in progress \(not accepted\)/); assert.strictEqual(ev.actorUserId, cardioDoctor.userId);
    await waitFor(async () => (await db.auditLog.count({ where: { action: 'EMERGENCY_ACKNOWLEDGED', entityId: c.id } })) === 1, 2000, 'ack audit entry');

    // Second acknowledgement at the same level (by anyone) cannot postpone it again
    const again = await req(A, 'POST', `/admin/emergencies/${c.id}/acknowledge`, { token: admin.token });
    assert.strictEqual(again.status, 409); assert.match(again.body.message, /already been acknowledged/);
    assert.deepStrictEqual((await row(c.id)).nextEscalationAt, em.nextEscalationAt, 'pause not extended');

    // Not before the pause ends…
    await sleep(Math.max(0, em.nextEscalationAt - Date.now() - 400));
    assert.strictEqual((await escalations(c.id)).length, 0, 'no escalation during the pause');
    // …then escalation resumes
    await waitFor(levelReached(c.id, 1), 5000, 'resumed escalation');
    const [l1] = await escalations(c.id);
    assert.ok(l1.createdAt >= em.nextEscalationAt, 'level 1 only after the pause');
    assert.deepStrictEqual(l1.dueAt, em.nextEscalationAt);

    // A new level may be acknowledged once more (by an admin this time)
    const ack2 = await req(A, 'POST', `/admin/emergencies/${c.id}/acknowledge`, { token: admin.token });
    assert.strictEqual(ack2.status, 200, JSON.stringify(ack2.body));
    em = await row(c.id);
    assert.strictEqual(em.acknowledgedLevel, 1); assert.strictEqual(em.acknowledgedByUserId, admin.user.id);
    await waitFor(levelReached(c.id, 2), 8000, 'level 2 after the second pause');
    assert.ok((await escalations(c.id))[1].createdAt >= em.nextEscalationAt, 'level 2 only after the second pause');
    await req(A, 'POST', `/admin/emergencies/${c.id}/resolve`, { token: admin.token, body: { notes: 'test cleanup' } });
  });

  // ── Things that stop escalation ──
  await test('doctor acceptance stops escalation (before the first level and part-way through)', async () => {
    const early = await createEmergency(A, 'CRITICAL', cardiology.id);
    const acc = await req(A, 'POST', `/doctor/emergencies/${early.id}/accept`, { token: cardio.token, body: {} });
    assert.strictEqual(acc.status, 200);
    assert.strictEqual((await row(early.id)).nextEscalationAt, null, 'cleared in the same update as the acceptance');
    const ackAccepted = await req(A, 'POST', `/doctor/emergencies/${early.id}/acknowledge`, { token: cardio.token });
    assert.strictEqual(ackAccepted.status, 409, 'cannot acknowledge an accepted case');

    const mid = await createEmergency(A, 'CRITICAL', cardiology.id);
    await waitFor(levelReached(mid.id, 1), 5000, 'level 1');
    assert.strictEqual((await req(A, 'POST', `/doctor/emergencies/${mid.id}/accept`, { token: cardio.token, body: {} })).status, 200);
    await sleep(secs('CRITICAL') * 3 * 1000);
    assert.strictEqual((await escalations(early.id)).length, 0, 'accepted before level 1: none');
    assert.strictEqual((await escalations(mid.id)).length, 1, 'accepted after level 1: no further levels');
    for (const id of [early.id, mid.id]) {
      const em = await row(id);
      assert.strictEqual(em.status, 'ACCEPTED'); assert.strictEqual(em.assignedDoctorId, cardioDoctor.id, 'the accepting doctor, unchanged');
      assert.strictEqual(em.priority, 'CRITICAL');
    }
    for (const id of [early.id, mid.id]) await req(A, 'POST', `/doctor/emergencies/${id}/resolve`, { token: cardio.token, body: {} });
  });

  await test('admin assignment, resolution and patient cancellation stop escalation', async () => {
    const assigned = await createEmergency(A, 'CRITICAL', cardiology.id);
    const resolved = await createEmergency(A, 'CRITICAL', cardiology.id);
    const cancelled = await createEmergency(A, 'CRITICAL', cardiology.id);
    assert.strictEqual((await req(A, 'PATCH', `/admin/emergencies/${assigned.id}`, { token: admin.token, body: { assignDoctorId: cardioDoctor.id } })).status, 200);
    assert.strictEqual((await req(A, 'POST', `/admin/emergencies/${resolved.id}/resolve`, { token: admin.token, body: { notes: 'Handled' } })).status, 200);
    assert.strictEqual((await req(A, 'POST', `/patient/emergencies/${cancelled.id}/cancel`, { token: cancelled.patient.token })).status, 200);
    for (const c of [assigned, resolved, cancelled]) assert.strictEqual((await row(c.id)).nextEscalationAt, null);
    await sleep(secs('CRITICAL') * 3 * 1000);
    for (const c of [assigned, resolved, cancelled]) assert.strictEqual((await escalations(c.id)).length, 0, `${(await row(c.id)).status}: no escalation`);
    await req(A, 'POST', `/admin/emergencies/${assigned.id}/resolve`, { token: admin.token, body: {} });
  });

  await test('manual priority changes are human-only and audited (admin update and doctor escalation); the clock follows the new priority', async () => {
    const c = await createEmergency(A, 'LOW', cardiology.id);
    const up = await req(A, 'PATCH', `/admin/emergencies/${c.id}`, { token: admin.token, body: { priority: 'HIGH' } });
    assert.strictEqual(up.status, 200);
    const log = await waitFor(() => db.auditLog.findFirst({ where: { action: 'EMERGENCY_PRIORITY_CHANGED', entityId: c.id } }), 2000, 'priority audit');
    assert.deepStrictEqual({ from: log.details.from, to: log.details.to, via: log.details.via }, { from: 'LOW', to: 'HIGH', via: 'admin update' });
    assert.strictEqual(log.userId, admin.user.id);
    const em = await row(c.id);
    const [{ now }] = await db.$queryRaw`SELECT now() AS now`;
    const left = (em.nextEscalationAt - now) / 1000;
    assert.ok(left > secs('HIGH') - 1 && left <= secs('HIGH'), `next step follows the HIGH target (${left}s left)`);

    // Doctor's manual escalation (existing behaviour: raises priority one step) is audited with from/to
    const esc = await req(A, 'POST', `/doctor/emergencies/${c.id}/escalate`, { token: cardio.token, body: { reason: 'Needs senior review' } });
    assert.strictEqual(esc.status, 200, JSON.stringify(esc.body));
    const escLog = await waitFor(() => db.auditLog.findFirst({ where: { action: 'EMERGENCY_ESCALATED', entityId: c.id } }), 2000, 'escalate audit');
    assert.deepStrictEqual([escLog.details.priorityFrom, escLog.details.priorityTo], ['HIGH', 'CRITICAL']);
    await waitFor(async () => (await db.auditLog.count({ where: { action: 'EMERGENCY_PRIORITY_CHANGED', entityId: c.id } })) === 2, 2000, 'second priority audit');
    // Automatic steps afterwards keep the human-set priority and skip the doctor who handed the case on
    await waitFor(levelReached(c.id, 1), 6000, 'automatic level 1 after manual escalation');
    const [l1] = await escalations(c.id);
    assert.strictEqual(l1.priority, 'CRITICAL'); assert.strictEqual((await row(c.id)).priority, 'CRITICAL');
    assert.ok(!l1.notifiedUserIds.includes(cardioDoctor.userId), 'the doctor who escalated by hand is not re-alerted automatically');
    assert.strictEqual(await db.auditLog.count({ where: { action: 'EMERGENCY_PRIORITY_CHANGED', entityId: c.id } }), 2, 'automatic escalation adds no priority change');
    await req(A, 'POST', `/admin/emergencies/${c.id}/resolve`, { token: admin.token, body: {} });
  });

  cardioSocket.close(); adminSocket.close();

  // ── Phase 2: three API instances on the same database ──
  await test('three API instances: every case escalated exactly once per level (SKIP LOCKED + unique level)', async () => {
    const B = startApi('B', 5012); const C = startApi('C', 5013);
    await Promise.all([ready(B), ready(C)]);
    const insts = [A, B, C];
    const many = [];
    for (let i = 0; i < 9; i += 1) many.push(await createEmergency(insts[i % 3], 'CRITICAL', cardiology.id));
    await waitFor(async () => (await Promise.all(many.map((c) => levelReached(c.id, 3)()))).every(Boolean), 20000, 'all to reach level 3');
    await sleep(1000);
    for (const c of many) {
      assert.deepStrictEqual((await escalations(c.id)).map((r) => r.level), [1, 2, 3]);
      assert.strictEqual((await eventsOf(c.id, 'AUTO_ESCALATED')).length, 3, 'three timeline events');
      const notes = await db.notification.groupBy({ by: ['userId', 'title'], where: { message: { contains: c.tag }, title: { contains: 'escalation level' } }, _count: { _all: true } });
      assert.ok(notes.length > 0 && notes.every((n) => n._count._all === 1), 'one notification per person per level');
      await waitFor(async () => (await db.auditLog.count({ where: { action: 'EMERGENCY_AUTO_ESCALATED', entityId: c.id } })) === 3, 2000, 'three audit entries');
    }
    const lines = insts.flatMap((i) => [...i.log.matchAll(/emergency (\S+) escalated to level (\d)/g)].map((m) => ({ inst: i.name, key: `${m[1]}:${m[2]}` })))
      .filter((l) => many.some((c) => l.key.startsWith(c.id)));
    assert.strictEqual(lines.length, 27, 'exactly 27 escalations performed in total');
    assert.strictEqual(new Set(lines.map((l) => l.key)).size, 27, 'no (case, level) handled twice');
    const by = Object.fromEntries(insts.map((i) => [i.name, lines.filter((l) => l.inst === i.name).length]));
    console.log(`      work split across instances: ${JSON.stringify(by)}`);
    assert.ok(Object.values(by).filter((n) => n > 0).length >= 2, 'more than one instance took part');
    // The database itself rejects a second record for the same level
    await assert.rejects(db.emergencyEscalation.create({ data: { emergencyId: many[0].id, level: 1, priority: 'CRITICAL', targetMinutes: 1, dueAt: new Date(), notifiedDoctors: 0, notifiedAdmins: 0 } }), /Unique constraint/);
    await Promise.all(many.map((c) => req(A, 'POST', `/admin/emergencies/${c.id}/resolve`, { token: admin.token, body: {} })));
    await Promise.all([stopApi(B), stopApi(C)]);
  });
  await stopApi(A);

  // ── Phase 3: crash before commit, then recovery ──
  await test('worker crash before commit leaves no partial escalation; a restarted instance escalates the case once', async () => {
    const F = await ready(startApi('F-crash', 5031, { ESCALATION_FAULT: 'crash-before-commit' }));
    const c = await createEmergency(F, 'CRITICAL', cardiology.id);
    const code = await Promise.race([F.exited, sleep(8000).then(() => 'still running')]);
    assert.strictEqual(code, 137, `instance crashed inside the escalation transaction (${code})`);
    let em = await row(c.id);
    assert.strictEqual(em.autoEscalationLevel, 0, 'level unchanged');
    assert.ok(em.nextEscalationAt && em.nextEscalationAt <= new Date(), 'still due');
    assert.strictEqual((await escalations(c.id)).length, 0, 'no escalation record');
    assert.strictEqual((await eventsOf(c.id, 'AUTO_ESCALATED')).length, 0, 'no timeline event');
    assert.strictEqual(await db.notification.count({ where: { message: { contains: c.tag }, title: { contains: 'escalation level' } } }), 0, 'no notifications');

    const G = await ready(startApi('G-recovered', 5032));
    await waitFor(levelReached(c.id, 3), 10000, 'recovery to escalate');
    em = await row(c.id);
    assert.deepStrictEqual((await escalations(c.id)).map((r) => r.level), [1, 2, 3], 'each level exactly once after recovery');
    assert.strictEqual((await eventsOf(c.id, 'AUTO_ESCALATED')).length, 3);
    const admin2 = await login(G, 'admin@medicore.com', 'Admin@123');
    await req(G, 'POST', `/admin/emergencies/${c.id}/resolve`, { token: admin2.token, body: {} });
    await stopApi(G);
  });

  // ── Phase 4: production mode ──
  const prodEnv = { NODE_ENV: 'production', JWT_SECRET: PROD_SECRET, AUTH_RATE_LIMIT: '50' };
  await test('production: worker OFF by default — nothing is scheduled or escalated', async () => {
    const P = await ready(startApi('P-default', 5021, prodEnv));
    assert.match(P.log, /automatic emergency escalation is OFF: off by default in production/);
    const adm = await login(P, 'admin@medicore.com', 'Admin@123');
    const cfg = await req(P, 'GET', '/admin/escalation-config', { token: adm.token });
    assert.strictEqual(cfg.body.data.enabled, false); assert.strictEqual(cfg.body.data.production, true);
    const c = await createEmergency(P, 'CRITICAL', cardiology.id);
    await sleep(secs('CRITICAL') * 2 * 1000 + 500);
    const em = await row(c.id);
    assert.strictEqual(em.nextEscalationAt, null, 'not scheduled');
    assert.strictEqual(em.autoEscalationLevel, 0); assert.strictEqual((await escalations(c.id)).length, 0);
    assert.strictEqual((await eventsOf(c.id, 'ESCALATION_SCHEDULED')).length, 0, 'timeline does not claim automatic escalation');
    // Acknowledgement still works as a record, without scheduling anything
    const ack = await req(P, 'POST', `/admin/emergencies/${c.id}/acknowledge`, { token: adm.token });
    assert.strictEqual(ack.status, 200); assert.strictEqual((await row(c.id)).nextEscalationAt, null);
    await req(P, 'POST', `/admin/emergencies/${c.id}/resolve`, { token: adm.token, body: {} });
    await stopApi(P);
  });
  await test('production: ESCALATION_ENABLED=true without an approval reference stays OFF; with one it starts', async () => {
    const P2 = await ready(startApi('P-noref', 5022, { ...prodEnv, ESCALATION_ENABLED: 'true' }));
    assert.match(P2.log, /OFF: ESCALATION_ENABLED=true but ESCALATION_APPROVAL_REF is missing/);
    await stopApi(P2);
    const P3 = await ready(startApi('P-approved', 5023, { ...prodEnv, ESCALATION_ENABLED: 'true', ESCALATION_APPROVAL_REF: 'TEST ONLY — not a real approval' }));
    await waitFor(() => /escalation is ON .*approval: TEST ONLY/.test(P3.log), 3000, 'ON with approval');
    await stopApi(P3);
  });

  await test('emergencies that existed before this test (seeded / pre-migration) were never escalated', async () => {
    const touched = await db.emergencyEscalation.findMany({ where: { emergencyId: { in: [...emergencyIdsBefore] } } });
    assert.strictEqual(touched.length, 0);
    const legacy = await db.emergencyRequest.count({ where: { id: { in: [...emergencyIdsBefore] }, autoEscalationLevel: { gt: 0 } } });
    assert.strictEqual(legacy, 0);
  });

  await test('no API instance logged an unexpected error', async () => {
    // Collected from every instance started above (fault-injection exit excluded)
    const errors = allLogs.join('\n').split('\n').filter((l) => /TypeError|ReferenceError|tick failed|Unhandled|PrismaClient\w*Error/.test(l));
    assert.deepStrictEqual(errors, []);
    // privacy: server logs never contain symptom text
    assert.ok(!/Test case ESC-/.test(allLogs.join('\n')), 'no symptoms in the API logs');
  });

  console.log(`\nEscalation tests: ${passed} passed, ${failed} failed`);
  if (failed) console.log(results.filter((r) => r.includes('✘')).join('\n'));
  await db.$disconnect();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('Escalation suite crashed:', e);
  for (const i of instances) console.error(`--- ${i.name} log ---\n${i.log.slice(-3000)}`);
  process.exit(1);
});

