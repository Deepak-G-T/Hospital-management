/* eslint-disable no-console */
// P1 item 7 — doctor/admin/patient access to patient medical information.
// Runs against a live API AND its disposable *_test database (fixtures are created directly in the database, then every
// check goes through the real HTTP endpoints):
//   API_URL=http://localhost:5001 DATABASE_URL=…/smart_hospital_test npm run test:access
// Covers accepted / completed / rejected / cancelled / no-show / pending appointments, active / resolved emergencies,
// alerted-only doctors, referrals, unrelated patients, report and prescription downloads, doctor writes, admin reasons,
// audit records (including fail-closed), and that no existing clinical data is removed.
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { io } = require('socket.io-client');
const { PrismaClient } = require('@prisma/client');

const DB_URL = process.env.DATABASE_URL || '';
if (!/_test(\?|$)/.test(DB_URL)) { console.log('Skipped: set DATABASE_URL to a disposable *_test database'); process.exit(0); }
const BASE = process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`;
const API = `${BASE}/api`;
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
const { REPORT_DIR } = require('../src/middleware/upload');
const policy = require('../src/policies/patientAccess');

let passed = 0; let failed = 0;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(`  ✔ ${name}`); } catch (e) { failed += 1; results.push(`  ✘ ${name}\n      ${String(e.stack).split('\n').slice(0, 3).join('\n      ')}`); }
}
async function req(method, p, { token, body, form, reason, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (reason !== undefined) headers['X-Access-Reason'] = encodeURIComponent(reason);
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(API + p, { method, headers, body: payload });
  if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, data: json && json.data };
}
async function login(email, password) {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  assert.strictEqual(r.status, 200, `login ${email}: ${JSON.stringify(r.body)}`);
  return { token: r.body.token, user: r.body.user };
}

// ── Fixtures ──
const H = 3600 * 1000;
let slot = 0;
const when = (offsetHours, minutes = 30) => { slot += 1; const start = new Date(Date.now() + offsetHours * H + slot * 60000); return { startAt: start, endAt: new Date(start.getTime() + minutes * 60000) }; };
const tag = () => crypto.randomBytes(4).toString('hex');

async function newPatient(label) {
  const email = `acc.${label}.${Date.now()}.${tag()}@example.com`;
  const r = await req('POST', '/auth/register', { body: { email, password: 'Start@1234', fullName: `Access ${label}` } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const patient = await db.patient.findUnique({ where: { userId: r.body.user.id } });
  return { id: patient.id, userId: r.body.user.id, token: r.body.token, label };
}

/** Gives a patient one allergy and a clinical record of each kind written by `ownDoctor` (default D1) and by D2 (other) */
async function clinical(p, { d1, d2, ownAppt = null, ownDoctor = d1 }) {
  const out = {};
  out.allergy = await db.allergy.create({ data: { patientId: p.id, allergen: `Allergen-${p.label}`, type: 'DRUG', severity: 'SEVERE' } });
  out.recOther = await db.patientMedicalRecord.create({ data: { patientId: p.id, createdByUserId: d2.userId, recordType: 'CONDITION', title: `OTHER-REC-${p.label}` } });
  out.recOwn = await db.patientMedicalRecord.create({ data: { patientId: p.id, createdByUserId: ownDoctor.userId, appointmentId: ownAppt, recordType: 'DIAGNOSIS', title: `OWN-REC-${p.label}` } });
  const rx = (doctorId, appointmentId, kind) => db.prescription.create({
    data: { prescriptionNumber: `RX-T-${tag()}`.toUpperCase(), patientId: p.id, doctorId, appointmentId, diagnosis: `${kind}-RX-${p.label}`, items: { create: [{ medicineName: 'TestMed', dosage: '1', frequency: 'daily', durationDays: 3 }] } },
  });
  out.rxOther = await rx(d2.id, null, 'OTHER');
  out.rxOwn = await rx(ownDoctor.id, ownAppt, 'OWN');
  const report = async (doctor, appointmentId, kind) => {
    const storedName = `access-test-${tag()}.pdf`;
    fs.writeFileSync(path.join(REPORT_DIR, storedName), '%PDF-1.4\n%access test\n');
    cleanup.push(path.join(REPORT_DIR, storedName));
    return db.medicalReport.create({ data: { patientId: p.id, doctorId: doctor.id, appointmentId, uploadedByUserId: doctor.userId, title: `${kind}-REPORT-${p.label}`, reportType: 'LAB', fileName: 'r.pdf', storedName, mimeType: 'application/pdf', fileSize: 24 } });
  };
  out.repOther = await report(d2, null, 'OTHER');
  out.repOwn = await report(ownDoctor, ownAppt, 'OWN');
  return out;
}
const cleanup = [];
const titles = (list, key = 'title') => list.map((x) => x[key]);
const auditRows = (where) => db.auditLog.findMany({ where, orderBy: { createdAt: 'asc' } });
const waitAudit = async (where, n = 1, ms = 3000) => { const end = Date.now() + ms; for (;;) { const rows = await auditRows(where); if (rows.length >= n) return rows; if (Date.now() > end) return rows; await sleep(80); } };

(async () => {
  // ── people ──
  const admin = await login('admin@medicore.com', 'Admin@123');
  const docRow = async (email) => { const u = await db.user.findUnique({ where: { email }, include: { doctor: true } }); return { id: u.doctor.id, userId: u.id, email }; };
  const D1 = await docRow('david.chen@medicore.com');     // the doctor under test
  const D2 = await docRow('priya.raman@medicore.com');    // another doctor who wrote "other" records
  const D3 = await docRow('sarah.mitchell@medicore.com'); // a doctor with no link to any fixture patient
  const doc1 = await login(D1.email, 'Doctor@123');
  const doc3 = await login(D3.email, 'Doctor@123');
  const department = await db.department.findFirst({ where: { name: 'Cardiology' } });
  const appt = (patientId, doctorId, status, offsetHours, extra = {}) => db.appointment.create({ data: { patientId, doctorId, departmentId: department.id, status, type: 'CONSULTATION', reason: 'access test', ...when(offsetHours), ...extra } });

  // snapshot of existing clinical data: nothing may disappear
  const snapshot = async () => ({
    records: (await db.patientMedicalRecord.findMany({ select: { id: true } })).map((r) => r.id),
    rx: (await db.prescription.findMany({ select: { id: true } })).map((r) => r.id),
    reports: (await db.medicalReport.findMany({ select: { id: true } })).map((r) => r.id),
    allergies: (await db.allergy.findMany({ select: { id: true } })).map((r) => r.id),
    appts: (await db.appointment.findMany({ select: { id: true } })).map((r) => r.id),
  });
  const before = await snapshot();

  // ── patients, one per situation ──
  const P = {};
  for (const k of ['confirmed', 'recent', 'completed', 'stale', 'rejected', 'cancelled', 'noshow', 'pending', 'unrelated', 'emActive', 'emAlerted', 'emResolved', 'emAlertedClosed', 'refAccepted', 'refPending', 'refDeclined', 'refCompleted', 'writeTarget', 'other', 'authored']) P[k] = await newPatient(k);
  const C = {}; // clinical fixtures per patient
  const A = {}; // D1's appointment per patient

  A.confirmed = await appt(P.confirmed.id, D1.id, 'CONFIRMED', 24 * 7);               // in a week
  A.recent = await appt(P.recent.id, D1.id, 'COMPLETED', -2);                          // completed 2 h ago → still inside the documentation window
  A.completed = await appt(P.completed.id, D1.id, 'COMPLETED', -24 * 30);              // a month ago
  A.stale = await appt(P.stale.id, D1.id, 'CONFIRMED', -24 * 5);                       // confirmed, ended 5 days ago, never completed
  A.rejected = await appt(P.rejected.id, D1.id, 'REJECTED', 24);
  A.cancelled = await appt(P.cancelled.id, D1.id, 'CANCELLED', 48);
  A.noshow = await appt(P.noshow.id, D1.id, 'NO_SHOW', -24 * 3);
  A.pending = await appt(P.pending.id, D1.id, 'PENDING', 72);
  A.writeTarget = await appt(P.writeTarget.id, D1.id, 'COMPLETED', -24 * 20);          // completed long ago: writes only by explicit link
  A.otherDoctor = await appt(P.other.id, D2.id, 'CONFIRMED', 24);                      // someone else's patient
  A.authored = await appt(P.authored.id, D1.id, 'CANCELLED', 24 * 2);                  // cancelled now, but D1 wrote records back when it was valid

  // Patients where D1 has no legitimate relationship hold NOTHING written by D1 (D2 wrote the "own" items there)
  const NO_RELATIONSHIP = new Set(['rejected', 'cancelled', 'noshow', 'pending', 'unrelated', 'emAlerted', 'emAlertedClosed', 'refPending', 'refDeclined', 'other']);
  for (const k of Object.keys(P)) {
    C[k] = await clinical(P[k], { d1: D1, d2: D2, ownAppt: A[k]?.id ?? null, ownDoctor: NO_RELATIONSHIP.has(k) ? D2 : D1 });
  }

  const emergency = (patient, data) => db.emergencyRequest.create({ data: { patientId: patient.id, priority: 'HIGH', symptoms: `Access test emergency ${patient.label}`, departmentId: department.id, autoEscalationEnabled: false, ...data } });
  const E = {};
  E.active = await emergency(P.emActive, { status: 'ACCEPTED', assignedDoctorId: D1.id, acceptedAt: new Date() });
  await db.emergencyNotification.create({ data: { emergencyId: E.active.id, doctorId: D1.id, status: 'ACCEPTED' } });
  E.alerted = await emergency(P.emAlerted, { status: 'NOTIFIED' });
  await db.emergencyNotification.create({ data: { emergencyId: E.alerted.id, doctorId: D1.id } });
  E.resolved = await emergency(P.emResolved, { status: 'RESOLVED', assignedDoctorId: D1.id, acceptedAt: new Date(Date.now() - 5 * H), resolvedAt: new Date(Date.now() - 4 * H) });
  await db.emergencyNotification.create({ data: { emergencyId: E.resolved.id, doctorId: D1.id, status: 'ACCEPTED' } });
  E.alertedClosed = await emergency(P.emAlertedClosed, { status: 'RESOLVED', assignedDoctorId: D2.id, resolvedAt: new Date(Date.now() - 4 * H) });
  await db.emergencyNotification.createMany({ data: [{ emergencyId: E.alertedClosed.id, doctorId: D1.id, status: 'EXPIRED' }, { emergencyId: E.alertedClosed.id, doctorId: D2.id, status: 'ACCEPTED' }] });

  const referral = (patient, status) => db.referral.create({ data: { patientId: patient.id, fromDoctorId: D2.id, toDoctorId: D1.id, reason: 'access test referral', status } });
  await referral(P.refAccepted, 'ACCEPTED'); await referral(P.refPending, 'PENDING'); await referral(P.refDeclined, 'DECLINED'); await referral(P.refCompleted, 'COMPLETED');

  const chart = (p, tok = doc1.token) => req('GET', `/doctor/patients/${p.id}`, { token: tok });
  const dl = {
    report: (item, tok = doc1.token, reason) => req('GET', `/files/reports/${item.id}`, { token: tok, raw: true, reason }),
    rx: (item, tok = doc1.token, reason) => req('GET', `/files/prescriptions/${item.id}/pdf`, { token: tok, raw: true, reason }),
  };

  // ═══════════ DOCTOR — appointments ═══════════
  await test('DOCTOR · accepted (confirmed) appointment → treatment access to the necessary clinical data', async () => {
    const r = await chart(P.confirmed);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.data.access.level, 'TREATMENT'); assert.deepStrictEqual(r.data.access.bases, ['ACTIVE_APPOINTMENT']); assert.strictEqual(r.data.access.canWrite, true);
    assert.strictEqual(r.data.allergies.length, 1);
    assert.deepStrictEqual(titles(r.data.medicalRecords).sort(), [`OTHER-REC-confirmed`, `OWN-REC-confirmed`]);
    assert.strictEqual(r.data.prescriptions.length, 2); assert.strictEqual(r.data.medicalReports.length, 2);
    assert.ok(r.data.appointments.every((a) => a.id === A.confirmed.id), 'only the doctor\'s own appointments are shown');
    assert.strictEqual((await dl.report(C.confirmed.repOther)).status, 200, 'other doctor\'s report downloadable while treating');
    assert.strictEqual((await dl.rx(C.confirmed.rxOther)).status, 200);
  });
  await test('DOCTOR · consultation completed moments ago stays in the documentation window (treatment access)', async () => {
    const r = await chart(P.recent);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.access.level, 'TREATMENT');
    assert.deepStrictEqual(r.data.access.bases, ['ACTIVE_APPOINTMENT']);
  });
  await test('DOCTOR · completed consultation long ago → only the records tied to that consultation', async () => {
    const r = await chart(P.completed);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.data.access.level, 'HISTORICAL'); assert.strictEqual(r.data.access.canWrite, false);
    assert.deepStrictEqual(titles(r.data.medicalRecords), ['OWN-REC-completed']);
    assert.deepStrictEqual(titles(r.data.prescriptions, 'diagnosis'), ['OWN-RX-completed']);
    assert.deepStrictEqual(titles(r.data.medicalReports), ['OWN-REPORT-completed']);
    assert.deepStrictEqual(r.data.allergies, [], 'allergies need an active relationship');
    // downloads follow the same rule
    assert.strictEqual((await dl.report(C.completed.repOwn)).status, 200, 'own/linked report still downloadable');
    assert.strictEqual((await dl.rx(C.completed.rxOwn)).status, 200, 'issued prescription still downloadable');
    assert.strictEqual((await dl.report(C.completed.repOther)).status, 403, 'other doctor\'s report is not');
    assert.strictEqual((await dl.rx(C.completed.rxOther)).status, 403, 'other doctor\'s prescription is not');
  });
  await test('DOCTOR · confirmed appointment that ended days ago and was never completed is no longer active (history only)', async () => {
    const r = await chart(P.stale);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.access.level, 'HISTORICAL'); assert.deepStrictEqual(r.data.allergies, []);
    assert.deepStrictEqual(titles(r.data.medicalRecords), ['OWN-REC-stale']);
  });
  for (const [label, key] of [['rejected', 'rejected'], ['cancelled', 'cancelled'], ['no-show', 'noshow'], ['pending (not yet accepted)', 'pending']]) {
    await test(`DOCTOR · ${label} appointment grants NO access to the patient's medical information (chart and every download)`, async () => {
      const r = await chart(P[key]);
      assert.strictEqual(r.status, 403, JSON.stringify(r.body));
      for (const item of [C[key].repOwn, C[key].repOther]) assert.strictEqual((await dl.report(item)).status, 403, 'report download');
      for (const item of [C[key].rxOwn, C[key].rxOther]) assert.strictEqual((await dl.rx(item)).status, 403, 'prescription PDF');
      const list = (await req('GET', '/doctor/patients?limit=100', { token: doc1.token })).data.items;
      assert.ok(!list.some((p) => p.id === P[key].id), 'not listed among the doctor\'s patients');
    });
  }
  await test('DOCTOR · unrelated patient → 403 everywhere, nothing leaks, attempts are audit-logged', async () => {
    const before = await db.auditLog.count({ where: { action: 'MEDICAL_ACCESS_DENIED', userId: doc1.user.id, entityId: P.unrelated.id } });
    const r = await chart(P.unrelated);
    assert.strictEqual(r.status, 403); assert.ok(!JSON.stringify(r.body).includes('Allergen'), 'no clinical text in the error');
    assert.strictEqual((await dl.report(C.unrelated.repOther)).status, 403); assert.strictEqual((await dl.rx(C.unrelated.rxOther)).status, 403);
    const rows = await waitAudit({ action: 'MEDICAL_ACCESS_DENIED', userId: doc1.user.id, entityId: P.unrelated.id }, before + 3);
    assert.ok(rows.length >= before + 3, `denials logged (${rows.length - before})`);
    assert.ok(rows.every((x) => x.ipAddress && x.details.resource), 'with IP and what was attempted');
    // a doctor with no link to anybody
    for (const p of [P.confirmed, P.completed, P.other]) assert.strictEqual((await chart(p, doc3.token)).status, 403, `unrelated doctor / ${p.label}`);
    assert.strictEqual((await dl.report(C.confirmed.repOwn, doc3.token)).status, 403);
    assert.strictEqual((await dl.rx(C.confirmed.rxOwn, doc3.token)).status, 403);
    assert.strictEqual((await chart({ id: crypto.randomUUID() })).status, 403, 'unknown patient id reveals nothing');
    assert.strictEqual((await req('GET', `/doctor/patients/${P.other.id}`, { token: doc1.token })).status, 403, 'a patient of another doctor');
  });
  await test('DOCTOR · what a doctor wrote or issued stays theirs after the relationship ends (cancelled later), the rest of the chart does not', async () => {
    assert.strictEqual((await chart(P.authored)).status, 403, 'chart closed');
    assert.strictEqual((await dl.report(C.authored.repOwn)).status, 200, 'own report still downloadable');
    assert.strictEqual((await dl.rx(C.authored.rxOwn)).status, 200, 'own prescription still downloadable');
    assert.strictEqual((await dl.report(C.authored.repOther)).status, 403); assert.strictEqual((await dl.rx(C.authored.rxOther)).status, 403);
  });
  await test('DOCTOR · patient list contains exactly the patients with a chart-level relationship', async () => {
    const ids = new Set((await req('GET', '/doctor/patients?limit=100', { token: doc1.token })).data.items.map((p) => p.id));
    for (const k of ['confirmed', 'recent', 'completed', 'stale', 'emActive', 'emResolved', 'refAccepted', 'refCompleted', 'writeTarget']) assert.ok(ids.has(P[k].id), `${k} listed`);
    for (const k of ['rejected', 'cancelled', 'noshow', 'pending', 'unrelated', 'emAlerted', 'emAlertedClosed', 'refPending', 'refDeclined', 'other', 'authored']) assert.ok(!ids.has(P[k].id), `${k} not listed`);
  });

  // ═══════════ DOCTOR — emergencies ═══════════
  await test('DOCTOR · active emergency the doctor accepted → emergency access: necessary records only, audit-logged', async () => {
    const r = await chart(P.emActive);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.data.access.level, 'EMERGENCY'); assert.deepStrictEqual(r.data.access.bases, ['ACTIVE_EMERGENCY']);
    assert.strictEqual(r.data.allergies.length, 1, 'allergies');
    assert.strictEqual(r.data.medicalRecords.length, 2, 'medical history'); assert.strictEqual(r.data.prescriptions.length, 2, 'prescriptions (medications)');
    assert.deepStrictEqual(r.data.medicalReports, [], 'reports are not "necessary" for emergency access');
    assert.deepStrictEqual(r.data.appointments, [], 'no appointment history');
    assert.strictEqual((await dl.report(C.emActive.repOther)).status, 403, 'report files are not released on emergency access');
    assert.strictEqual((await dl.rx(C.emActive.rxOther)).status, 200, 'prescriptions are');
    const [log] = await waitAudit({ action: 'MEDICAL_ACCESS_EXCEPTIONAL', userId: doc1.user.id, entityType: 'Patient', entityId: P.emActive.id });
    assert.ok(log, 'exceptional access audited'); assert.strictEqual(log.details.basis, 'ACTIVE_EMERGENCY'); assert.strictEqual(log.details.resource, 'PATIENT_CHART');
    assert.ok(log.ipAddress && log.userAgent !== null && log.userRole === 'DOCTOR');
    const w = await req('POST', `/doctor/patients/${P.emActive.id}/records`, { token: doc1.token, body: { recordType: 'DIAGNOSIS', title: 'Emergency finding' } });
    assert.strictEqual(w.status, 201, 'the treating doctor can document during the emergency');
  });
  await test('DOCTOR · resolved emergency the doctor handled → only records tied to it; no allergies, no writes', async () => {
    const r = await chart(P.emResolved);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.access.level, 'HISTORICAL'); assert.deepStrictEqual(r.data.access.bases, ['CLOSED_EMERGENCY']);
    assert.deepStrictEqual(r.data.allergies, []); assert.deepStrictEqual(titles(r.data.medicalRecords), ['OWN-REC-emResolved']);
    assert.strictEqual((await req('POST', `/doctor/patients/${P.emResolved.id}/records`, { token: doc1.token, body: { recordType: 'OTHER', title: 'late note' } })).status, 403);
  });
  await test('DOCTOR · only alerted to an active emergency → sees the emergency itself, NOT the chart; audit-logged', async () => {
    assert.strictEqual((await chart(P.emAlerted)).status, 403, 'no chart');
    assert.strictEqual((await dl.report(C.emAlerted.repOther)).status, 403);
    const list = (await req('GET', '/doctor/emergencies?scope=active', { token: doc1.token })).data;
    const mine = list.find((e) => e.id === E.alerted.id);
    assert.ok(mine, 'visible on the emergency board while active');
    assert.strictEqual(mine.patient.allergies.length, 1, 'the emergency payload carries the allergy information needed for triage');
    assert.ok(!('medicalRecords' in mine.patient) && !('prescriptions' in mine.patient), 'but no records');
    const rows = await waitAudit({ action: 'MEDICAL_ACCESS_EXCEPTIONAL', userId: doc1.user.id, entityType: 'EmergencyRequest', entityId: E.alerted.id });
    assert.strictEqual(rows[0].details.basis, 'ACTIVE_EMERGENCY_ALERTED'); assert.strictEqual(rows[0].details.resource, 'EMERGENCY_PATIENT_DETAILS');
    // repeated loads inside the window do not flood the log
    await req('GET', '/doctor/emergencies?scope=active', { token: doc1.token }); await req('GET', '/doctor/emergencies?scope=all', { token: doc1.token });
    assert.strictEqual((await auditRows({ action: 'MEDICAL_ACCESS_EXCEPTIONAL', userId: doc1.user.id, entityType: 'EmergencyRequest', entityId: E.alerted.id })).length, 1);
  });
  await test('DOCTOR · emergency board: closed emergencies stay only for the doctor who handled them', async () => {
    const hist = (await req('GET', '/doctor/emergencies?scope=history', { token: doc1.token })).data.map((e) => e.id);
    assert.ok(hist.includes(E.resolved.id), 'handled & resolved → kept as history');
    assert.ok(!hist.includes(E.alertedClosed.id), 'only alerted, then closed (handled by someone else) → gone');
    const all = (await req('GET', '/doctor/emergencies?scope=all', { token: doc1.token })).data.map((e) => e.id);
    assert.ok(all.includes(E.active.id) && all.includes(E.alerted.id) && all.includes(E.resolved.id) && !all.includes(E.alertedClosed.id));
    assert.strictEqual((await chart(P.emAlertedClosed)).status, 403);
  });
  await test('DOCTOR · cannot accept an emergency they were not alerted for (would grant record access); alerted doctors can', async () => {
    const em = await emergency((await newPatient('acceptgate')), { status: 'NOTIFIED' });
    await db.emergencyNotification.create({ data: { emergencyId: em.id, doctorId: D1.id } });
    const denied = await req('POST', `/doctor/emergencies/${em.id}/accept`, { token: doc3.token, body: {} });
    assert.strictEqual(denied.status, 403); assert.match(denied.body.message, /not alerted/);
    assert.strictEqual((await db.emergencyRequest.findUnique({ where: { id: em.id } })).assignedDoctorId, null);
    assert.strictEqual((await chart({ id: em.patientId }, doc3.token)).status, 403, 'and still no access');
    assert.strictEqual((await req('POST', `/doctor/emergencies/${em.id}/accept`, { token: doc1.token, body: {} })).status, 200);
    assert.strictEqual((await req('POST', `/doctor/emergencies/${em.id}/accept`, { token: doc3.token, body: {} })).status, 409, 'already taken');
    assert.strictEqual((await chart({ id: em.patientId })).data.access.level, 'EMERGENCY');
    assert.strictEqual((await req('POST', `/doctor/emergencies/${em.id}/resolve`, { token: doc1.token, body: {} })).status, 200);
    assert.strictEqual((await chart({ id: em.patientId })).data.access.level, 'HISTORICAL', 'access narrows the moment the emergency is resolved');
  });
  await test('DOCTOR · doctors alerted but not assigned receive no patient data when the emergency closes (socket)', async () => {
    const p = await newPatient('sockclose');
    const em = await emergency(p, { status: 'NOTIFIED' });
    await db.emergencyNotification.createMany({ data: [{ emergencyId: em.id, doctorId: D1.id }, { emergencyId: em.id, doctorId: D3.id }] });
    const connect = (token) => new Promise((resolve, reject) => { const s = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true }); s.once('connect', () => resolve(s)); s.once('connect_error', reject); });
    const [s1, s3, sa] = await Promise.all([connect(doc1.token), connect(doc3.token), connect(admin.token)]);
    const got = { d1: [], d3: [], admin: [] };
    s1.on('emergency:updated', (e) => got.d1.push(e)); s3.on('emergency:updated', (e) => got.d3.push(e)); sa.on('emergency:updated', (e) => got.admin.push(e));
    assert.strictEqual((await req('POST', `/doctor/emergencies/${em.id}/accept`, { token: doc1.token, body: {} })).status, 200);
    await sleep(400); got.d1.length = 0; got.d3.length = 0; got.admin.length = 0;
    assert.strictEqual((await req('POST', `/doctor/emergencies/${em.id}/resolve`, { token: doc1.token, body: {} })).status, 200);
    await sleep(800);
    const last = (a) => a.filter((e) => e.id === em.id).at(-1);
    assert.ok(last(got.d1).patient && last(got.d1).patient.allergies, 'the assigned doctor still gets the full update');
    assert.deepStrictEqual(last(got.d3), { id: em.id, status: 'RESOLVED', closed: true }, 'the alerted-only doctor gets a bare "closed" notice');
    assert.ok(last(got.admin).patient.clinicalWithheld === true && !('allergies' in last(got.admin).patient), 'admins get the operational view over the socket too');
    [s1, s3, sa].forEach((s) => s.close());
  });

  // ═══════════ DOCTOR — referrals ═══════════
  await test('DOCTOR · referrals: accepted → treatment; completed → history only; pending/declined → nothing', async () => {
    const acc = await chart(P.refAccepted); assert.strictEqual(acc.status, 200); assert.strictEqual(acc.data.access.level, 'TREATMENT'); assert.strictEqual(acc.data.allergies.length, 1);
    const done = await chart(P.refCompleted); assert.strictEqual(done.status, 200); assert.strictEqual(done.data.access.level, 'HISTORICAL'); assert.deepStrictEqual(done.data.allergies, []);
    assert.strictEqual((await chart(P.refPending)).status, 403); assert.strictEqual((await chart(P.refDeclined)).status, 403);
    // a referral the doctor SENT gives no access to the patient's chart by itself
    const sent = await newPatient('refsent');
    await db.referral.create({ data: { patientId: sent.id, fromDoctorId: D1.id, toDoctorId: D2.id, reason: 'sent', status: 'ACCEPTED' } });
    assert.strictEqual((await chart(sent)).status, 403);
  });

  // ═══════════ DOCTOR — writes ═══════════
  await test('DOCTOR · adding records, reports, prescriptions and referrals needs an active relationship (or a link to their own appointment)', async () => {
    const rec = (p, body = {}) => req('POST', `/doctor/patients/${p.id}/records`, { token: doc1.token, body: { recordType: 'OTHER', title: 'note', ...body } });
    const rxBody = (p, extra = {}) => ({ patientId: p.id, diagnosis: 'dx', items: [{ medicineName: 'X', dosage: '1', frequency: 'daily', durationDays: 2 }], ...extra });
    const upload = (p, extra = {}) => { const f = new FormData(); f.append('title', 'Lab'); f.append('reportType', 'LAB'); Object.entries(extra).forEach(([k, v]) => f.append(k, v)); f.append('file', new Blob(['%PDF-1.4\n%x\n'], { type: 'application/pdf' }), 'lab.pdf'); return req('POST', `/doctor/patients/${p.id}/reports`, { token: doc1.token, form: f }); };
    // active relationship
    assert.strictEqual((await rec(P.confirmed)).status, 201);
    assert.strictEqual((await req('POST', '/doctor/prescriptions', { token: doc1.token, body: rxBody(P.confirmed, { appointmentId: A.confirmed.id }) })).status, 201);
    const up = await upload(P.confirmed); assert.strictEqual(up.status, 201, JSON.stringify(up.body)); cleanup.push(path.join(REPORT_DIR, up.data.storedName));
    // no relationship / rejected / cancelled / pending / historical
    const filesBefore = fs.readdirSync(REPORT_DIR).length;
    for (const k of ['unrelated', 'rejected', 'cancelled', 'noshow', 'pending', 'completed', 'emAlerted']) {
      assert.strictEqual((await rec(P[k])).status, 403, `record → ${k}`);
      assert.strictEqual((await req('POST', '/doctor/prescriptions', { token: doc1.token, body: rxBody(P[k]) })).status, 403, `prescription → ${k}`);
      const u = await upload(P[k]); assert.strictEqual(u.status, 403, `report → ${k}`);
      assert.strictEqual((await req('POST', '/doctor/referrals', { token: doc1.token, body: { patientId: P[k].id, toDoctorId: D3.id, reason: 'try it' } })).status, 403, `referral → ${k}`);
    }
    await sleep(300);
    assert.strictEqual(fs.readdirSync(REPORT_DIR).length, filesBefore, 'refused uploads leave no file behind');
    // historical relationship, but documenting THAT consultation (explicit link to the doctor's own completed appointment)
    assert.strictEqual((await rec(P.writeTarget, { appointmentId: A.writeTarget.id })).status, 201);
    const linkedUp = await upload(P.writeTarget, { appointmentId: A.writeTarget.id }); assert.strictEqual(linkedUp.status, 201); cleanup.push(path.join(REPORT_DIR, linkedUp.data.storedName));
    assert.strictEqual((await req('POST', '/doctor/prescriptions', { token: doc1.token, body: rxBody(P.writeTarget, { appointmentId: A.writeTarget.id }) })).status, 201);
    // …but not by borrowing someone else's appointment or one that does not grant access
    assert.strictEqual((await rec(P.writeTarget, { appointmentId: A.otherDoctor.id })).status, 403, 'another doctor\'s appointment');
    assert.strictEqual((await rec(P.pending, { appointmentId: A.pending.id })).status, 403, 'a pending appointment');
    assert.strictEqual((await rec(P.confirmed, { appointmentId: A.otherDoctor.id })).status, 400, 'invalid link even with an active relationship');
    // the new historical entry stays reachable to its author
    assert.ok(titles((await chart(P.writeTarget)).data.medicalRecords).includes('note'));
  });
  await test('DOCTOR · referral to another doctor does not expose the chart until that doctor accepts', async () => {
    const r = await req('POST', '/doctor/referrals', { token: doc1.token, body: { patientId: P.confirmed.id, toDoctorId: D3.id, reason: 'second opinion' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual((await chart(P.confirmed, doc3.token)).status, 403, 'pending referral → nothing yet');
    await db.referral.update({ where: { id: r.data.id }, data: { status: 'ACCEPTED' } });
    assert.strictEqual((await chart(P.confirmed, doc3.token)).data.access.level, 'TREATMENT');
    await db.referral.update({ where: { id: r.data.id }, data: { status: 'DECLINED' } });
    assert.strictEqual((await chart(P.confirmed, doc3.token)).status, 403, 'declined → withdrawn');
  });
  await test('DOCTOR · rejected/cancelled appointments no longer expose the patient\'s blood group in appointment payloads', async () => {
    const list = (await req('GET', '/doctor/appointments?limit=100&status=REJECTED', { token: doc1.token })).data.items || [];
    assert.ok(list.length > 0 && list.every((a) => !('bloodGroup' in a.patient)));
  });

  // ═══════════ PATIENT ═══════════
  await test('PATIENT · reads only their own records, reports and prescriptions; others get 403', async () => {
    const me = P.confirmed; const other = P.completed;
    assert.ok((await req('GET', '/patient/medical-records', { token: me.token })).data.length >= 2);
    assert.strictEqual((await req('GET', '/patient/allergies', { token: me.token })).data.length, 1);
    assert.ok((await req('GET', '/patient/reports', { token: me.token })).data.items.length >= 2);
    assert.ok((await req('GET', '/patient/prescriptions', { token: me.token })).data.items.length >= 2);
    assert.strictEqual((await dl.report(C.confirmed.repOther, me.token)).status, 200); assert.strictEqual((await dl.rx(C.confirmed.rxOther, me.token)).status, 200);
    assert.strictEqual((await dl.report(C.completed.repOwn, me.token)).status, 403); assert.strictEqual((await dl.rx(C.completed.rxOwn, me.token)).status, 403);
    assert.ok(![...(await req('GET', '/patient/reports', { token: me.token })).data.items, ...(await req('GET', '/patient/prescriptions', { token: me.token })).data.items].some((x) => x.patientId === other.id));
    for (const url of [`/doctor/patients/${me.id}`, '/doctor/patients', '/admin/patients', `/admin/patients/${me.id}`, '/doctor/emergencies']) assert.strictEqual((await req('GET', url, { token: me.token })).status, 403, `patient → ${url}`);
    assert.strictEqual((await req('GET', `/admin/patients/${me.id}`, { token: me.token, reason: 'I would like to see my record please' })).status, 403, 'a reason header gives a patient nothing');
    assert.strictEqual((await req('GET', `/files/reports/${C.confirmed.repOwn.id}`, { raw: true })).status, 401, 'unauthenticated download');
    assert.strictEqual((await req('GET', `/files/prescriptions/${C.confirmed.rxOwn.id}/pdf`, { raw: true })).status, 401);
  });

  // ═══════════ ADMIN ═══════════
  const adminReason = 'Verifying records for a patient complaint';
  await test('ADMIN · patient record: operational data without a reason, clinical data only with one', async () => {
    const plain = await req('GET', `/admin/patients/${P.confirmed.id}`, { token: admin.token });
    assert.strictEqual(plain.status, 200); assert.strictEqual(plain.data.clinicalWithheld, true);
    assert.deepStrictEqual(plain.data.allergies, []); assert.deepStrictEqual(plain.data.medicalRecords, []);
    assert.ok(plain.data.fullName && plain.data.user.email, 'registration data is still available');
    const full = await req('GET', `/admin/patients/${P.confirmed.id}`, { token: admin.token, reason: adminReason });
    assert.strictEqual(full.status, 200); assert.strictEqual(full.data.clinicalWithheld, false);
    assert.strictEqual(full.data.allergies.length, 1); assert.ok(titles(full.data.medicalRecords).includes('OTHER-REC-confirmed') && titles(full.data.medicalRecords).includes('OWN-REC-confirmed'));
  });
  await test('ADMIN · reason validation: missing/too short/too long/blank → 400 REASON_REQUIRED and nothing released', async () => {
    for (const reason of ['short', '          ', 'x'.repeat(501), '\n\n\n\n\n\n\n\n\n\n\n\n']) {
      const r = await req('GET', `/admin/patients/${P.confirmed.id}`, { token: admin.token, reason });
      assert.strictEqual(r.status, 400, `"${reason.slice(0, 12)}"`); assert.strictEqual(r.body.details.code, 'REASON_REQUIRED');
      assert.ok(!JSON.stringify(r.body).includes('Allergen'));
    }
    for (const dlf of [() => dl.report(C.confirmed.repOwn, admin.token), () => dl.rx(C.confirmed.rxOwn, admin.token)]) {
      const r = await dlf(); assert.strictEqual(r.status, 400);
    }
    // a reason cannot be smuggled in through the URL or the body
    assert.strictEqual((await req('GET', `/admin/patients/${P.confirmed.id}?reason=${encodeURIComponent(adminReason)}`, { token: admin.token })).data.clinicalWithheld, true);
  });
  await test('ADMIN · every clinical access with a reason is audit-logged with the reason, what was opened, user, role and IP', async () => {
    const t0 = new Date();
    assert.strictEqual((await req('GET', `/admin/patients/${P.confirmed.id}`, { token: admin.token, reason: adminReason })).status, 200);
    assert.strictEqual((await dl.report(C.confirmed.repOwn, admin.token, 'Legal request: export a copy – ünïcode')).status, 200);
    assert.strictEqual((await dl.rx(C.confirmed.rxOwn, admin.token, adminReason)).status, 200);
    await sleep(300);
    const rows = await db.auditLog.findMany({ where: { action: 'MEDICAL_ACCESS_EXCEPTIONAL', userId: admin.user.id, createdAt: { gte: t0 } }, orderBy: { createdAt: 'asc' } });
    assert.deepStrictEqual(rows.map((r) => r.details.resource), ['ADMIN_PATIENT_RECORD', 'REPORT_DOWNLOAD', 'PRESCRIPTION_PDF']);
    assert.ok(rows.every((r) => r.details.basis === 'ADMIN_REASON' && r.details.patientId === P.confirmed.id && r.userRole === 'ADMIN' && r.ipAddress));
    assert.strictEqual(rows[0].details.reason, adminReason); assert.strictEqual(rows[1].details.reason, 'Legal request: export a copy – ünïcode', 'non-ASCII reasons survive the header');
    assert.strictEqual(rows[1].details.itemId, C.confirmed.repOwn.id);
    // the pre-existing action names are still written too
    assert.ok(await db.auditLog.count({ where: { action: 'REPORT_DOWNLOADED', userId: admin.user.id, createdAt: { gte: t0 } } }) >= 1);
    // the reason is stored once cleaned (no control characters)
    const messy = await req('GET', `/admin/patients/${P.confirmed.id}`, { token: admin.token, reason: 'Line one\nLine\ttwo with control chars' });
    assert.strictEqual(messy.status, 200);
    const last = (await auditRows({ userId: admin.user.id, action: 'MEDICAL_ACCESS_EXCEPTIONAL' })).at(-1);
    assert.strictEqual(last.details.reason, 'Line one Line two with control chars');
  });
  await test('ADMIN · emergencies: operational view by default; clinical details need a reason, only while active; audited', async () => {
    const plain = (await req('GET', `/admin/emergencies/${E.active.id}`, { token: admin.token })).data;
    assert.strictEqual(plain.patient.clinicalWithheld, true); assert.ok(!('allergies' in plain.patient)); assert.ok(plain.patient.fullName && plain.symptoms, 'operational data intact');
    const list = (await req('GET', '/admin/emergencies?status=active&limit=100', { token: admin.token })).data.items;
    assert.ok(list.length > 0 && list.every((e) => !('allergies' in e.patient) && e.patient.clinicalWithheld === true), 'list never carries allergies');
    const withReason = await req('GET', `/admin/emergencies/${E.active.id}`, { token: admin.token, reason: 'Emergency coordination for patient transfer' });
    assert.strictEqual(withReason.status, 200); assert.strictEqual(withReason.data.patient.allergies.length, 1); assert.strictEqual(withReason.data.patient.clinicalWithheld, false);
    const [log] = await waitAudit({ action: 'MEDICAL_ACCESS_EXCEPTIONAL', userId: admin.user.id, entityType: 'EmergencyRequest', entityId: E.active.id });
    assert.strictEqual(log.details.resource, 'EMERGENCY_PATIENT_DETAILS'); assert.strictEqual(log.details.reason, 'Emergency coordination for patient transfer'); assert.strictEqual(log.details.emergencyId, E.active.id);
    assert.strictEqual((await req('GET', `/admin/emergencies/${E.active.id}`, { token: admin.token, reason: 'short' })).status, 400);
    const closed = await req('GET', `/admin/emergencies/${E.resolved.id}`, { token: admin.token, reason: 'Emergency coordination for patient transfer' });
    assert.strictEqual(closed.status, 403); assert.match(closed.body.message, /patient record/);
    assert.ok(!('allergies' in (await req('GET', `/admin/emergencies/${E.resolved.id}`, { token: admin.token })).data.patient));
    // other admin responses about an emergency do not leak the allergy list either
    const upd = await req('PATCH', `/admin/emergencies/${E.alerted.id}`, { token: admin.token, body: { priority: 'CRITICAL' } });
    assert.strictEqual(upd.status, 200); assert.ok(!('allergies' in upd.data.patient));
    assert.strictEqual((await req('POST', `/admin/emergencies/${E.alerted.id}/acknowledge`, { token: admin.token })).status, 200);
  });
  await test('ADMIN · the same rules reach admin-only routes: doctors and anonymous callers are refused', async () => {
    assert.strictEqual((await req('GET', `/admin/patients/${P.confirmed.id}`, { token: doc1.token, reason: adminReason })).status, 403, 'a doctor header-reason gives nothing');
    assert.strictEqual((await req('GET', `/admin/emergencies/${E.active.id}`, { token: doc1.token, reason: adminReason })).status, 403);
    assert.strictEqual((await req('GET', `/admin/patients/${P.confirmed.id}`, {})).status, 401);
  });
  await test('FAIL-CLOSED · if the audit entry cannot be written, exceptional access is refused', async () => {
    const ghost = { id: crypto.randomUUID(), role: 'ADMIN', accessReason: adminReason, profileId: null }; // user id that does not exist → audit insert fails
    await assert.rejects(policy.authorizeChart(ghost, P.confirmed.id, 'ADMIN_PATIENT_RECORD'), 'access must not be granted without an audit record');
    const ghostDoctor = { id: crypto.randomUUID(), role: 'DOCTOR', profileId: D1.id };
    await assert.rejects(policy.authorizeChart(ghostDoctor, P.emActive.id, 'PATIENT_CHART'), 'emergency-based doctor access too');
    await policy.authorizeChart(ghostDoctor, P.confirmed.id, 'PATIENT_CHART'); // ordinary treatment access is not "exceptional": no audit write required
  });

  // ═══════════ Data safety ═══════════
  await test('NO DATA LOSS · every clinical record that existed before the checks still exists', async () => {
    const after = await snapshot();
    for (const k of Object.keys(before)) { const now = new Set(after[k]); assert.deepStrictEqual(before[k].filter((id) => !now.has(id)), [], `${k} removed`); }
  });

  for (const f of cleanup) fs.unlink(f, () => {});
  console.log(results.join('\n'));
  console.log(`\nAccess tests: ${passed} passed, ${failed} failed`);
  await db.$disconnect();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('Access suite crashed:', e); process.exit(1); });
