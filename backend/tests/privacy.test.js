/* eslint-disable no-console */
// Privacy review: minimum necessary data for administrators and doctors.
//   API_URL=http://localhost:5001 DATABASE_URL=…/smart_hospital_test npm run test:privacy
// Covers: appointment clinical fields (API, dashboard, socket), admin patient list/detail fields, blood group at registration,
// updates that never overwrite with blank values, patient-identifying exports (reason, 366-day cap, columns), REPORT_EXPORTED
// auditing (metadata only, fail-closed), the doctor's patient list, generic notifications and Socket.IO payloads, audit logs.
require('dotenv').config({ quiet: true });
const assert = require('assert');
const crypto = require('crypto');
const { io } = require('socket.io-client');
const { PrismaClient } = require('@prisma/client');

const DB_URL = process.env.DATABASE_URL || '';
if (!/_test(\?|$)/.test(DB_URL)) { console.log('Skipped: set DATABASE_URL to a disposable *_test database'); process.exit(0); }
const BASE = process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`;
const API = `${BASE}/api`;
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

let passed = 0; let failed = 0;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(`  ✔ ${name}`); } catch (e) { failed += 1; results.push(`  ✘ ${name}\n      ${String(e.stack).split('\n').slice(0, 3).join('\n      ')}`); }
}
async function req(method, p, { token, body, reason, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (reason !== undefined) headers['X-Access-Reason'] = encodeURIComponent(reason);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return { status: res.status, headers: res.headers, text: await res.text() };
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, data: json && json.data };
}
async function login(email, password) {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  assert.strictEqual(r.status, 200, `login ${email}: ${JSON.stringify(r.body)}`);
  return { token: r.body.token, user: r.body.user };
}
const tag = () => crypto.randomBytes(4).toString('hex');
async function newPatient(label) {
  const email = `priv.${label}.${Date.now()}.${tag()}@example.com`;
  const r = await req('POST', '/auth/register', { body: { email, password: 'Start@1234', fullName: `Privacy ${label}` } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const patient = await db.patient.findUnique({ where: { userId: r.body.user.id } });
  return { id: patient.id, userId: r.body.user.id, token: r.body.token, label, email };
}
const day = (offset) => { const d = new Date(Date.now() + offset * 86400000); return d.toISOString().slice(0, 10); };
const keys = (o) => Object.keys(o).sort();
const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(80); } };
const connect = (token) => new Promise((resolve, reject) => { const s = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true }); s.once('connect', () => resolve(s)); s.once('connect_error', reject); });
const CLINICAL_APPT = ['diagnosis', 'treatment', 'notes'];
const REASON = 'Quarterly review of patient registrations';

(async () => {
  const t0 = new Date();
  const admin = await login('admin@medicore.com', 'Admin@123');
  const docRow = async (email) => { const u = await db.user.findUnique({ where: { email }, include: { doctor: true } }); return { id: u.doctor.id, userId: u.id, email }; };
  const D1 = await docRow('david.chen@medicore.com');
  const D2 = await docRow('priya.raman@medicore.com');
  const doc1 = await login(D1.email, 'Doctor@123');
  const cardiology = await db.department.findFirst({ where: { name: 'Cardiology' } });
  let slot = 0;
  const when = (offsetHours) => { slot += 1; const startAt = new Date(Date.now() + offsetHours * 3600000 + slot * 60000); return { startAt, endAt: new Date(startAt.getTime() + 1800000) }; };
  const appt = (patientId, doctorId, status, offsetHours, extra = {}) => db.appointment.create({ data: { patientId, doctorId, departmentId: cardiology.id, status, type: 'CONSULTATION', reason: 'privacy test visit', ...when(offsetHours), ...extra } });
  const clinicalText = { diagnosis: `DIAG-${tag()}`, treatment: `TREAT-${tag()}`, notes: `NOTE-${tag()}` };

  // ═══════════ 1. Appointments ═══════════
  const apptPatient = await newPatient('appt');
  const pending = await appt(apptPatient.id, D1.id, 'PENDING', 48, clinicalText);
  const done = await appt(apptPatient.id, D1.id, 'COMPLETED', -24 * 20, clinicalText);

  await test('APPOINTMENTS · admin list has no diagnosis/treatment/notes but keeps reason, status, patient, doctor', async () => {
    const r = await req('GET', '/admin/appointments?limit=100&status=COMPLETED', { token: admin.token });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.items.length > 50);
    for (const a of r.data.items) { for (const k of CLINICAL_APPT) assert.ok(!(k in a), `${k} leaked`); assert.ok(a.reason && a.status && a.patient.fullName && a.doctor.fullName && a.startAt); }
    const row = (await req('GET', `/admin/appointments?search=${encodeURIComponent('privacy test visit')}&limit=100`, { token: admin.token })).data.items.find((a) => a.id === done.id);
    assert.ok(row && !('diagnosis' in row), 'the fixture appointment (with clinical text in the database) is listed without it');
    assert.ok((await db.appointment.findUnique({ where: { id: done.id } })).diagnosis === clinicalText.diagnosis, 'and the data itself is untouched in the database');
  });
  await test('APPOINTMENTS · doctor and patient still see the clinical fields of their own appointments', async () => {
    const mine = (await req('GET', '/doctor/appointments?limit=100&status=COMPLETED&scope=past', { token: doc1.token })).data.items.find((a) => a.id === done.id);
    assert.strictEqual(mine.diagnosis, clinicalText.diagnosis); assert.strictEqual(mine.treatment, clinicalText.treatment);
    const theirs = (await req('GET', '/patient/appointments?scope=past&limit=100', { token: apptPatient.token })).data.items.find((a) => a.id === done.id);
    assert.strictEqual(theirs.diagnosis, clinicalText.diagnosis);
  });
  await test('APPOINTMENTS · admin status change response, dashboard and patient detail carry no clinical fields', async () => {
    const dash = await req('GET', '/admin/dashboard', { token: admin.token });
    assert.ok(dash.data.recentAppointments.length > 0 && dash.data.recentAppointments.every((a) => CLINICAL_APPT.every((k) => !(k in a))));
    const detail = await req('GET', `/admin/patients/${apptPatient.id}`, { token: admin.token });
    assert.ok(detail.data.appointments.length >= 2 && detail.data.appointments.every((a) => CLINICAL_APPT.every((k) => !(k in a))), 'detail without reason');
    const detailReason = await req('GET', `/admin/patients/${apptPatient.id}`, { token: admin.token, reason: 'Checking an appointment complaint' });
    assert.ok(detailReason.data.appointments.every((a) => CLINICAL_APPT.every((k) => !(k in a))), 'even with a reason, diagnosis text is not part of the admin appointment list');
    assert.ok(detailReason.data.appointments.every((a) => a.reason && a.status && a.doctor.fullName), 'scheduling data intact');
  });
  await test('APPOINTMENTS · Socket.IO: admins get no clinical fields, the patient and doctor still do', async () => {
    const [sa, sp, sd] = await Promise.all([connect(admin.token), connect(apptPatient.token), connect(doc1.token)]);
    const got = { admin: [], patient: [], doctor: [] };
    sa.on('appointment:updated', (a) => got.admin.push(a)); sp.on('appointment:updated', (a) => got.patient.push(a)); sd.on('appointment:updated', (a) => got.doctor.push(a));
    const r = await req('PATCH', `/admin/appointments/${pending.id}/status`, { token: admin.token, body: { status: 'CONFIRMED' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(CLINICAL_APPT.every((k) => !(k in r.data)) && r.data.status === 'CONFIRMED', 'HTTP response to the admin');
    await waitFor(() => got.admin.some((a) => a.id === pending.id) && got.patient.some((a) => a.id === pending.id) && got.doctor.some((a) => a.id === pending.id));
    const find = (arr) => arr.find((a) => a.id === pending.id);
    assert.ok(find(got.admin) && CLINICAL_APPT.every((k) => !(k in find(got.admin))), 'admin room payload');
    assert.ok(!JSON.stringify(got.admin).includes(clinicalText.diagnosis));
    assert.strictEqual(find(got.patient).diagnosis, clinicalText.diagnosis, 'patient payload unchanged');
    assert.strictEqual(find(got.doctor).treatment, clinicalText.treatment, 'doctor payload unchanged');
    [sa, sp, sd].forEach((s) => s.close());
  });

  // ═══════════ 2 & 3. Admin patient list, registration, updates ═══════════
  await test('PATIENT LIST · no blood group, height, weight or allergy count; identity, contact and activity data remain', async () => {
    const withClinical = await db.patient.findMany({ where: { bloodGroup: { not: null } }, take: 5, select: { id: true } });
    assert.ok(withClinical.length > 0, 'the database holds blood groups (so the check is not vacuous)');
    const r = await req('GET', '/admin/patients?limit=100', { token: admin.token });
    assert.strictEqual(r.status, 200); assert.ok(r.data.items.length > 20);
    for (const p of r.data.items) {
      for (const k of ['bloodGroup', 'heightCm', 'weightKg', 'allergies', 'medicalRecords']) assert.ok(!(k in p), `${k} leaked in list`);
      assert.ok(!('allergies' in p._count), 'allergy count leaked'); assert.deepStrictEqual(keys(p._count), ['appointments', 'emergencyRequests']);
      assert.ok(p.id && p.fullName && p.user.email && 'phone' in p && 'dateOfBirth' in p && 'gender' in p && 'address' in p && 'emergencyContactName' in p && p.createdAt, 'registration data intact');
    }
    assert.ok(!JSON.stringify(r.body).match(/"(A|B|AB|O)_(POS|NEG)"/), 'no blood group value anywhere in the response');
    const found = await req('GET', `/admin/patients?search=${encodeURIComponent(r.data.items[0].fullName.split(' ')[0])}&limit=100`, { token: admin.token });
    assert.ok(found.data.items.length > 0, 'search still works');
  });
  const reg = { email: `priv.reg.${Date.now()}.${tag()}@example.com`, password: 'Temp@1234', fullName: 'Privacy Registered', phone: '+1 555 0142', dateOfBirth: '1990-05-17', gender: 'FEMALE', bloodGroup: 'O_POS', address: '12 Test Street' };
  let regId;
  await test('REGISTRATION · admin can enter blood group; it is stored, never returned by list, create, update or the plain detail', async () => {
    const c = await req('POST', '/admin/patients', { token: admin.token, body: reg });
    assert.strictEqual(c.status, 201, JSON.stringify(c.body));
    regId = c.data.id;
    assert.ok(!('bloodGroup' in c.data) && c.data.fullName === reg.fullName && c.data.user.email === reg.email, 'create response');
    assert.strictEqual((await db.patient.findUnique({ where: { id: regId } })).bloodGroup, 'O_POS', 'stored');
    assert.ok(!('bloodGroup' in (await req('GET', `/admin/patients/${regId}`, { token: admin.token })).data), 'plain detail');
    assert.ok(!JSON.stringify((await req('GET', `/admin/patients?search=Privacy%20Registered`, { token: admin.token })).body).includes('O_POS'), 'list');
    const full = await req('GET', `/admin/patients/${regId}`, { token: admin.token, reason: 'Verifying registration details' });
    assert.strictEqual(full.data.bloodGroup, 'O_POS', 'available through the reason-gated detail');
    assert.strictEqual((await req('POST', '/auth/login', { body: { email: reg.email, password: reg.password } })).status, 200, 'the new patient can log in');
    assert.strictEqual((await req('POST', '/admin/patients', { token: admin.token, body: { ...reg, bloodGroup: 'XX' } })).status, 400, 'invalid blood group still validated');
  });
  await test('UPDATES · blank, null, missing and no-op values never overwrite stored data; blood group cannot be changed here', async () => {
    await db.patient.update({ where: { id: regId }, data: { emergencyContactName: 'Contact Person', emergencyContactPhone: '+1 555 0100', heightCm: 170, weightKg: 65 } });
    const snap = () => db.patient.findUnique({ where: { id: regId }, include: { user: { select: { email: true } } } });
    const before = await snap();
    const put = (body) => req('PUT', `/admin/patients/${regId}`, { token: admin.token, body });
    // everything blank / null / missing, plus a bloodGroup attempt: accepted but ignored (200), or refused as invalid (400)
    for (const body of [{}, { phone: '', address: '', gender: '', dateOfBirth: '', emergencyContactName: '', emergencyContactPhone: '' }, { phone: null, address: null, gender: null, dateOfBirth: null, emergencyContactName: null }, { address: '   ' }, { bloodGroup: 'A_NEG', heightCm: 10, weightKg: 10 }]) {
      const r = await put(body);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(await snap(), before, `nothing may change for ${JSON.stringify(body)}`);
      assert.ok(!('bloodGroup' in r.data), 'response stays clinical-free');
    }
    for (const body of [{ fullName: '' }, { fullName: '   ' }, { phone: '   ' }]) { // not valid values: refused, and nothing changes
      assert.strictEqual((await put(body)).status, 400);
      assert.deepStrictEqual(await snap(), before);
    }
    assert.strictEqual(before.bloodGroup, 'O_POS');
    // no-op: values identical to the stored ones → nothing written (updatedAt unchanged)
    assert.deepStrictEqual(await (async () => { await put({ fullName: before.fullName, phone: before.phone, dateOfBirth: '1990-05-17', gender: 'FEMALE', email: reg.email }); return snap(); })(), before);
    // a real change touches only that field
    assert.strictEqual((await put({ phone: '+1 555 0199', address: '' })).status, 200);
    const changed = await snap();
    assert.strictEqual(changed.phone, '+1 555 0199');
    assert.deepStrictEqual({ ...changed, phone: before.phone, updatedAt: before.updatedAt }, before, 'only the phone changed');
    // several fields + email
    const newEmail = `priv.moved.${Date.now()}@example.com`;
    assert.strictEqual((await put({ fullName: 'Privacy Renamed', email: newEmail, dateOfBirth: '1991-01-02', emergencyContactPhone: '+1 555 0111' })).status, 200);
    const multi = await snap();
    assert.deepStrictEqual([multi.fullName, multi.user.email, multi.dateOfBirth.toISOString().slice(0, 10), multi.emergencyContactPhone], ['Privacy Renamed', newEmail, '1991-01-02', '+1 555 0111']);
    assert.deepStrictEqual([multi.phone, multi.gender, multi.bloodGroup, multi.emergencyContactName, Number(multi.heightCm)], ['+1 555 0199', 'FEMALE', 'O_POS', 'Contact Person', 170], 'untouched fields kept');
    assert.strictEqual((await put({ email: 'not-an-email' })).status, 400);
    assert.strictEqual((await req('PUT', `/admin/patients/${crypto.randomUUID()}`, { token: admin.token, body: { phone: '+1 555 0101' } })).status, 404);
  });

  // ═══════════ 4 & 5. Exports ═══════════
  const exportsLogged = () => db.auditLog.count({ where: { action: 'REPORT_EXPORTED' } });
  const csvOf = (p, reason, extra = '') => req('GET', `/admin/reports/${p}?format=csv${extra}`, { token: admin.token, reason, raw: true });
  const jsonOf = (p, reason, extra = '') => req('GET', `/admin/reports/${p}?${extra}`, { token: admin.token, reason });

  await test('EXPORTS · patients CSV and JSON carry no blood group (or any clinical value)', async () => {
    const j = await jsonOf('patients', REASON, `from=${day(-365)}&to=${day(0)}`);
    assert.strictEqual(j.status, 200, JSON.stringify(j.body));
    assert.deepStrictEqual(j.data.columns, ['Registered', 'Name', 'Email', 'Gender', 'Appointments', 'Emergencies']);
    assert.ok(j.data.rows.length > 10);
    const csv = await csvOf('patients', REASON, `&from=${day(-365)}&to=${day(0)}`);
    assert.strictEqual(csv.status, 200);
    assert.ok(!/blood/i.test(csv.text.split('\n')[0]), 'header');
    assert.ok(!/\b(A|B|AB|O)_(POS|NEG)\b|\b(A|B|AB|O)[+−-]\b/.test(csv.text.replace(/@[^\s,]+/g, '')), 'no blood group values in the CSV');
    assert.strictEqual(csv.text.split('\n').length - 1, j.data.rows.length, 'CSV and JSON have the same rows');
  });
  await test('EXPORTS · patient-identifying reports need a reason: missing, blank, too short and too long are refused (CSV and JSON)', async () => {
    const before = await exportsLogged();
    for (const type of ['patients', 'appointments', 'emergencies', 'complaints']) {
      for (const reason of [undefined, '', '   ', 'too short', 'x'.repeat(501)]) {
        const j = await jsonOf(type, reason); assert.strictEqual(j.status, 400, `${type} json "${reason}"`); assert.strictEqual(j.body.details.code, 'REASON_REQUIRED'); assert.match(j.body.message, /reason/i);
        assert.ok(!('rows' in (j.data || {})), 'no data in the error');
        const c = await csvOf(type, reason); assert.strictEqual(c.status, 400, `${type} csv "${reason}"`); assert.ok(!c.text.includes('Name,'), 'no CSV body');
      }
      assert.strictEqual((await jsonOf(type, REASON)).status, 200, `${type} with a reason`);
    }
    assert.strictEqual(await exportsLogged(), before + 4, 'only the 4 successful exports were logged');
    // a reason cannot be passed in the query string or body
    assert.strictEqual((await req('GET', `/admin/reports/patients?reason=${encodeURIComponent(REASON)}`, { token: admin.token })).status, 400);
    // aggregate reports (no patient names) stay open; non-admins are still refused
    for (const type of ['doctors', 'departments']) assert.strictEqual((await jsonOf(type)).status, 200, type);
    assert.strictEqual((await req('GET', '/admin/reports/patients', { token: doc1.token, reason: REASON })).status, 403);
  });
  await test('EXPORTS · date range is limited to 366 days for patient-identifying reports, with a clear error', async () => {
    const before = await exportsLogged();
    for (const type of ['patients', 'appointments', 'emergencies', 'complaints']) {
      const ok = await jsonOf(type, REASON, `from=${day(-365)}&to=${day(0)}`);
      assert.strictEqual(ok.status, 200, `${type}: 366 days inclusive is allowed`);
      const tooBig = await jsonOf(type, REASON, `from=${day(-366)}&to=${day(0)}`);
      assert.strictEqual(tooBig.status, 400, `${type}: 367 days refused`);
      assert.strictEqual(tooBig.body.details.code, 'EXPORT_RANGE_TOO_LARGE'); assert.strictEqual(tooBig.body.details.maxDays, 366); assert.strictEqual(tooBig.body.details.days, 367);
      assert.match(tooBig.body.message, /366 days/);
      const csv = await csvOf(type, REASON, `&from=${day(-1000)}&to=${day(0)}`);
      assert.strictEqual(csv.status, 400, `${type} csv, 1000 days`);
    }
    const backwards = await jsonOf('patients', REASON, `from=${day(0)}&to=${day(-5)}`);
    assert.strictEqual(backwards.status, 400); assert.strictEqual(backwards.body.details.code, 'EXPORT_RANGE_INVALID');
    assert.strictEqual((await jsonOf('doctors', undefined, `from=${day(-800)}&to=${day(0)}`)).status, 200, 'aggregate reports keep their flexible range');
    assert.strictEqual(await exportsLogged(), before + 4 + 1, 'refused requests are not logged as exports (4 patient-type ok + 1 aggregate)');
  });
  await test('EXPORT AUDIT · every export logs REPORT_EXPORTED with user, type, row count, columns, range, format and reason — metadata only', async () => {
    const mark = new Date();
    const range = `from=${day(-30)}&to=${day(0)}`;
    const j = await jsonOf('patients', REASON, range);
    const c = await csvOf('appointments', 'Reconciling appointment volumes', `&${range}`);
    const d = await jsonOf('doctors', undefined, range);
    await sleep(200);
    const rows = await db.auditLog.findMany({ where: { action: 'REPORT_EXPORTED', createdAt: { gte: mark } }, orderBy: { createdAt: 'asc' } });
    assert.strictEqual(rows.length, 3);
    const [lp, la, ld] = rows;
    for (const r of rows) assert.ok(r.userId === admin.user.id && r.userRole === 'ADMIN' && r.ipAddress, 'who and from where');
    assert.deepStrictEqual([lp.details.reportType, lp.details.rowCount, lp.details.format, lp.details.patientIdentifying, lp.details.reason], ['patients', j.data.rows.length, 'json', true, REASON]);
    assert.deepStrictEqual(lp.details.columns, j.data.columns);
    const csvLines = c.text.split('\n').filter(Boolean);
    assert.deepStrictEqual([la.details.reportType, la.details.rowCount, la.details.format], ['appointments', csvLines.length - 1, 'csv']);
    assert.strictEqual(la.details.columns.join(','), csvLines[0]);
    assert.deepStrictEqual([ld.details.reportType, ld.details.rowCount, ld.details.patientIdentifying, 'reason' in ld.details], ['doctors', d.data.rows.length, false, false]);
    assert.ok(new Date(lp.details.from) <= new Date(lp.details.to), 'range recorded');
    assert.ok(!(await db.auditLog.count({ where: { action: 'REPORT_GENERATED', createdAt: { gte: mark } } })), 'the old audit action is no longer written');
    // metadata only: nothing from the rows themselves ends up in the log
    const blob = JSON.stringify(rows.map((r) => r.details));
    for (const row of [...j.data.rows.slice(0, 15), ...csvLines.slice(1, 10).map((l) => l.split(','))]) for (const cell of row.slice(1, 3)) if (String(cell).length > 3 && !String(cell).includes('"')) assert.ok(!blob.includes(String(cell)), `row value "${cell}" leaked into the audit entry`);
    assert.deepStrictEqual(keys(lp.details), ['columns', 'format', 'from', 'patientIdentifying', 'reason', 'reportType', 'rowCount', 'to']);
  });
  await test('EXPORT AUDIT · if the audit entry cannot be written the report is NOT delivered (fail-closed)', async () => {
    const ctrl = require('../src/controllers/admin.controller');
    const sent = [];
    const res = { setHeader() {}, status() { return this; }, send: (x) => sent.push(x), json: (x) => sent.push(x) };
    const fake = (type, user) => ({ params: { type }, query: { from: day(-10), to: day(0), format: 'csv' }, user, headers: {}, ip: '127.0.0.1', socket: {} });
    const ghost = { id: crypto.randomUUID(), role: 'ADMIN', accessReason: REASON }; // not in users → the audit insert violates its foreign key
    await assert.rejects(ctrl.report(fake('patients', ghost), res), 'identifying report');
    await assert.rejects(ctrl.report(fake('doctors', { id: crypto.randomUUID(), role: 'ADMIN' }), res), 'aggregate report too');
    assert.deepStrictEqual(sent, [], 'nothing was sent to the client');
    // control: the same call with a real user delivers
    await ctrl.report(fake('patients', { id: admin.user.id, role: 'ADMIN', accessReason: REASON }), res);
    assert.strictEqual(sent.length, 1);
  });

  // ═══════════ 6. Doctor patient list ═══════════
  await test('DOCTOR LIST · blood group and allergy count appear only for patients the doctor is treating; the policy is unchanged', async () => {
    const mk = async (label, rel) => {
      const p = await newPatient(label);
      await db.patient.update({ where: { id: p.id }, data: { bloodGroup: 'B_NEG' } });
      await db.allergy.create({ data: { patientId: p.id, allergen: `Allergen-${label}`, type: 'DRUG', severity: 'SEVERE' } });
      await rel(p);
      return p;
    };
    const P = {
      active: await mk('lst-active', (p) => appt(p.id, D1.id, 'CONFIRMED', 24 * 5)),
      justDone: await mk('lst-justdone', (p) => appt(p.id, D1.id, 'COMPLETED', -2)),
      past: await mk('lst-past', (p) => appt(p.id, D1.id, 'COMPLETED', -24 * 30)),
      emActive: await mk('lst-emactive', (p) => db.emergencyRequest.create({ data: { patientId: p.id, priority: 'HIGH', status: 'ACCEPTED', symptoms: 'privacy list test', assignedDoctorId: D1.id, autoEscalationEnabled: false } })),
      emClosed: await mk('lst-emclosed', (p) => db.emergencyRequest.create({ data: { patientId: p.id, priority: 'HIGH', status: 'RESOLVED', symptoms: 'privacy list test', assignedDoctorId: D1.id, resolvedAt: new Date(), autoEscalationEnabled: false } })),
      refAccepted: await mk('lst-refacc', (p) => db.referral.create({ data: { patientId: p.id, fromDoctorId: D2.id, toDoctorId: D1.id, reason: 'privacy', status: 'ACCEPTED' } })),
      refDone: await mk('lst-refdone', (p) => db.referral.create({ data: { patientId: p.id, fromDoctorId: D2.id, toDoctorId: D1.id, reason: 'privacy', status: 'COMPLETED' } })),
    };
    const list = (await req('GET', '/doctor/patients?limit=100', { token: doc1.token })).data.items;
    const get = (p) => list.find((x) => x.id === p.id);
    for (const k of ['active', 'justDone', 'emActive', 'refAccepted']) { const row = get(P[k]); assert.ok(row, `${k} listed`); assert.strictEqual(row.bloodGroup, 'B_NEG', `${k}: blood group kept for a patient under treatment`); assert.strictEqual(row._count.allergies, 1, `${k}: allergy count kept`); }
    for (const k of ['past', 'emClosed', 'refDone']) {
      const row = get(P[k]); assert.ok(row, `${k} still listed (history relationship)`);
      assert.ok(!('bloodGroup' in row) && !('_count' in row), `${k}: no blood group or allergy count`);
      assert.ok(row.fullName && row.phone !== undefined && 'dateOfBirth' in row && row.appointments !== undefined, `${k}: identity data intact`);
    }
    assert.ok(!JSON.stringify(list.filter((x) => ['past', 'emClosed', 'refDone'].some((k) => P[k].id === x.id))).includes('B_NEG'));
    // the prescription / referral pickers only offer patients the doctor can act for now
    const pick = (await req('GET', '/doctor/patients?treating=true&limit=100', { token: doc1.token })).data.items.map((x) => x.id);
    for (const k of ['active', 'justDone', 'emActive', 'refAccepted']) assert.ok(pick.includes(P[k].id), `${k} offered`);
    for (const k of ['past', 'emClosed', 'refDone']) assert.ok(!pick.includes(P[k].id), `${k} not offered`);
    assert.ok(pick.length < list.length, 'a filtered list');
    // the detailed chart still follows the Item 7 policy
    const chartOf = (p) => req('GET', `/doctor/patients/${p.id}`, { token: doc1.token });
    const act = await chartOf(P.active); assert.strictEqual(act.data.bloodGroup, 'B_NEG'); assert.strictEqual(act.data.allergies.length, 1); assert.strictEqual(act.data.access.level, 'TREATMENT');
    const past = await chartOf(P.past); assert.strictEqual(past.data.access.level, 'HISTORICAL'); assert.deepStrictEqual(past.data.allergies, []);
  });

  // ═══════════ 7. Notifications and Socket.IO ═══════════
  await test('NOTIFICATIONS · stored texts and socket payloads for a new emergency carry no symptoms; authorised views still show them', async () => {
    const marker = `MARK${tag()}`;
    const p = await newPatient('notif');
    const [sa, sd] = await Promise.all([connect(admin.token), connect(doc1.token)]);
    const seen = { adminNote: [], docNote: [], alert: [], adminEm: [], docEm: [] };
    sa.on('notification:new', (n) => seen.adminNote.push(n)); sd.on('notification:new', (n) => seen.docNote.push(n));
    sd.on('emergency:alert', (a) => seen.alert.push(a));
    sa.on('emergency:new', (e) => seen.adminEm.push(e)); sd.on('emergency:updated', (e) => seen.docEm.push(e));
    const created = await req('POST', '/patient/emergencies', { token: p.token, body: { priority: 'CRITICAL', departmentId: cardiology.id, symptoms: `Crushing chest pain ${marker}`, description: `Long description ${marker}` } });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const id = created.data.id; const ref = id.slice(0, 8);
    await waitFor(() => seen.alert.length && seen.adminNote.length && seen.docNote.length);
    // sockets
    assert.ok(seen.alert.some((a) => a.id === id), 'doctor alert arrived');
    assert.deepStrictEqual(keys(seen.alert.find((a) => a.id === id)), ['id', 'priority'], 'alert payload: id and priority only');
    for (const n of [...seen.adminNote, ...seen.docNote]) assert.ok(!JSON.stringify(n).includes(marker) && !/chest|pain|crushing/i.test(`${n.title} ${n.message}`), `socket notification "${n.message}"`);
    const adminNote = seen.adminNote.find((n) => n.message.includes(ref)); const docNote = seen.docNote.find((n) => n.message.includes(ref));
    assert.ok(adminNote && docNote, 'both notified with the short reference');
    assert.match(adminNote.message, /^New emergency request requires attention/);
    // database: the permanently stored notifications are the same generic text
    const stored = await db.notification.findMany({ where: { message: { contains: ref } } });
    assert.ok(stored.length >= 2 && stored.every((n) => !n.message.includes(marker) && !/chest|pain|crushing/i.test(n.message)));
    // authorised operational views are unchanged
    const adminView = (await req('GET', `/admin/emergencies/${id}`, { token: admin.token })).data;
    assert.ok(adminView.symptoms.includes(marker) && adminView.description.includes(marker), 'admin emergency view keeps symptoms');
    const docView = (await req('GET', '/doctor/emergencies?scope=active', { token: doc1.token })).data.find((e) => e.id === id);
    assert.ok(docView && docView.symptoms.includes(marker), 'the alerted doctor\'s board keeps symptoms');
    assert.ok(seen.adminEm.some((e) => e.id === id && e.symptoms.includes(marker)), 'operational socket events to authorised roles still carry the case');
    // manual escalation by the doctor and admin assignment: no reason / symptom text in stored admin or doctor notifications
    const accept = await req('POST', `/doctor/emergencies/${id}/accept`, { token: doc1.token, body: {} });
    assert.strictEqual(accept.status, 200);
    const esc = await req('POST', `/doctor/emergencies/${id}/escalate`, { token: doc1.token, body: { reason: `Needs cardiology ${marker}` } });
    assert.strictEqual(esc.status, 200, JSON.stringify(esc.body));
    const assign = await req('PATCH', `/admin/emergencies/${id}`, { token: admin.token, body: { assignDoctorId: D2.id } });
    assert.strictEqual(assign.status, 200);
    await sleep(500);
    assert.strictEqual(await db.notification.count({ where: { OR: [{ message: { contains: marker } }, { title: { contains: marker } }] } }), 0, 'no stored notification anywhere contains the symptoms or the escalation reason');
    const escNote = await db.notification.findFirst({ where: { title: 'Emergency escalated', message: { contains: ref }, user: { role: 'ADMIN' } } });
    assert.ok(escNote && /timeline/.test(escNote.message), 'admins are told it was escalated, generically');
    const assignNote = await db.notification.findFirst({ where: { title: 'Emergency assigned to you', message: { contains: ref } } });
    assert.ok(assignNote && !/chest|pain/i.test(assignNote.message));
    // the clinical detail lives where it is authorised: the emergency timeline
    const timeline = (await req('GET', `/admin/emergencies/${id}`, { token: admin.token })).data.events.map((e) => e.message).join('\n');
    assert.ok(timeline.includes(marker), 'escalation reason is on the timeline');
    // the in-app notification list the admin and doctor fetch is clean too
    for (const tok of [admin.token, doc1.token]) assert.ok(!JSON.stringify((await req('GET', '/notifications?limit=100', { token: tok })).body).includes(marker));
    [sa, sd].forEach((s) => s.close());
    await req('POST', `/admin/emergencies/${id}/resolve`, { token: admin.token, body: { notes: 'privacy test cleanup' } });
  });
  await test('LOGS · audit entries written during this run contain no patient clinical text', async () => {
    const rows = await db.auditLog.findMany({ where: { createdAt: { gte: t0 } } });
    assert.ok(rows.length > 20);
    const blob = JSON.stringify(rows.map((r) => ({ a: r.action, d: r.details, e: r.entityId })));
    for (const text of Object.values(clinicalText)) assert.ok(!blob.includes(text), `"${text}" found in the audit log`);
    assert.ok(!/Crushing chest pain|Long description|Needs cardiology|\bO_POS\b|\bB_NEG\b|Allergen-/.test(blob), 'no symptoms, escalation reasons, blood groups or allergens in audit metadata');
  });

  console.log(results.join('\n'));
  console.log(`\nPrivacy tests: ${passed} passed, ${failed} failed`);
  await db.$disconnect();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Privacy suite crashed:', e); process.exit(1); });
