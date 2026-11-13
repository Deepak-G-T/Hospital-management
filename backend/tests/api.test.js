/* eslint-disable no-console */
// End-to-end API test: exercises all three portals against a running server + seeded DB.
// Usage: npm run db:seed && npm start (in another terminal) && npm test
require('dotenv').config({ quiet: true });
const assert = require('assert');
const { io } = require('socket.io-client');

const BASE = process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`;
const API = `${BASE}/api`;
let passed = 0; let failed = 0;
const results = [];

async function req(method, path, { token, body, form, raw, reason } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (reason) headers['X-Access-Reason'] = encodeURIComponent(reason);
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(API + path, { method, headers, body: payload });
  if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function test(name, fn) {
  try { await fn(); passed += 1; results.push(`  ✔ ${name}`); }
  catch (e) { failed += 1; results.push(`  ✘ ${name}\n      ${e.message}`); }
}

const login = async (email, password) => {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  assert.strictEqual(r.status, 200, `login ${email}: ${JSON.stringify(r.body)}`);
  return r.body;
};

function nextWeekday(dow) {
  const d = new Date(); d.setDate(d.getDate() + 1);
  while (d.getDay() !== dow) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function waitForEvent(socket, event, predicate = () => true, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    const handler = (payload) => { if (predicate(payload)) { clearTimeout(t); socket.off(event, handler); resolve(payload); } };
    socket.on(event, handler);
  });
}

(async () => {
  const stamp = Date.now();
  const ctx = {};

  await test('health check', async () => {
    const r = await req('GET', '/health'); assert.strictEqual(r.status, 200);
  });

  await test('auth: invalid credentials rejected, valid login works', async () => {
    const bad = await req('POST', '/auth/login', { body: { email: 'admin@medicore.com', password: 'wrong-password1' } });
    assert.strictEqual(bad.status, 401);
    ctx.admin = await login('admin@medicore.com', 'Admin@123');
    assert.strictEqual(ctx.admin.user.role, 'ADMIN');
    assert.ok(!('passwordHash' in ctx.admin.user), 'password hash must never be returned');
  });

  await test('security: protected routes need a token and the right role', async () => {
    assert.strictEqual((await req('GET', '/admin/dashboard')).status, 401);
    const p = await login('patient@medicore.com', 'Patient@123');
    ctx.seedPatient = p;
    assert.strictEqual((await req('GET', '/admin/dashboard', { token: p.token })).status, 403);
    assert.strictEqual((await req('GET', '/doctor/dashboard', { token: p.token })).status, 403);
    assert.strictEqual((await req('GET', '/patient/dashboard', { token: ctx.admin.token })).status, 403);
  });

  await test('validation: bad input returns 400 with a message', async () => {
    const r = await req('POST', '/auth/register', { body: { email: 'not-an-email', password: 'short', fullName: 'X' } });
    assert.strictEqual(r.status, 400); assert.ok(r.body.message);
  });

  await test('admin: create department', async () => {
    const r = await req('POST', '/admin/departments', { token: ctx.admin.token, body: { name: `Test Dept ${stamp}`, description: 'E2E', keywords: 'zebra-test-symptom', icon: 'Stethoscope' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body)); ctx.dept = r.body.data;
  });

  await test('admin: create doctor assigned to multiple departments (with Mon-Fri availability)', async () => {
    const deps = await req('GET', '/admin/departments', { token: ctx.admin.token });
    const cardiology = deps.body.data.find((d) => d.name === 'Cardiology');
    ctx.cardiology = cardiology;
    const r = await req('POST', '/admin/doctors', {
      token: ctx.admin.token,
      body: {
        email: `e2e.doctor.${stamp}@medicore.com`, password: 'Doctor@123', fullName: 'E2E Tester', specialization: 'Test Medicine',
        licenseNumber: `E2E-${stamp}`, consultationFee: 100, experienceYears: 5, departmentIds: [ctx.dept.id, cardiology.id], primaryDepartmentId: ctx.dept.id,
      },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.data.departments.length, 2);
    ctx.doctorId = r.body.data.id;
  });

  await test('doctor portal: admin-created doctor can log in and sees departments', async () => {
    ctx.doctor = await login(`e2e.doctor.${stamp}@medicore.com`, 'Doctor@123');
    assert.strictEqual(ctx.doctor.user.role, 'DOCTOR');
    assert.strictEqual(ctx.doctor.user.profile.departments.length, 2);
    const pub = await req('GET', `/public/doctors?departmentId=${ctx.dept.id}`);
    assert.ok(pub.body.data.some((d) => d.id === ctx.doctorId), 'doctor appears in public directory');
  });

  await test('patient: register, update blood group, add allergy and condition', async () => {
    const r = await req('POST', '/auth/register', { body: { email: `e2e.patient.${stamp}@example.com`, password: 'Patient@123', fullName: 'E2E Patient', phone: '+1 555 999 0000' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body)); ctx.patient = r.body;
    const dup = await req('POST', '/auth/register', { body: { email: `e2e.patient.${stamp}@example.com`, password: 'Patient@123', fullName: 'Dup' } });
    assert.strictEqual(dup.status, 409, 'duplicate email rejected');
    assert.strictEqual((await req('PUT', '/patient/profile', { token: ctx.patient.token, body: { bloodGroup: 'O_NEG' } })).status, 200);
    assert.strictEqual((await req('POST', '/patient/allergies', { token: ctx.patient.token, body: { allergen: 'Penicillin', type: 'DRUG', severity: 'SEVERE', reaction: 'Hives' } })).status, 201);
    assert.strictEqual((await req('POST', '/patient/allergies', { token: ctx.patient.token, body: { allergen: 'Peanuts', type: 'FOOD', severity: 'LIFE_THREATENING' } })).status, 201);
    assert.strictEqual((await req('POST', '/patient/medical-records', { token: ctx.patient.token, body: { recordType: 'CONDITION', title: 'Asthma' } })).status, 201);
  });

  await test('booking: slots come from availability; booking appears for doctor and admin', async () => {
    ctx.date = nextWeekday(3); // a Wednesday
    const slots = await req('GET', `/public/doctors/${ctx.doctorId}/slots?date=${ctx.date}`);
    assert.strictEqual(slots.status, 200);
    const free = slots.body.data.slots.filter((s) => s.available);
    assert.ok(free.length >= 3, 'has free slots');
    ctx.slot = free[0].startAt; ctx.slot2 = free[1].startAt; ctx.slot3 = free[2].startAt;
    const r = await req('POST', '/patient/appointments', { token: ctx.patient.token, body: { doctorId: ctx.doctorId, startAt: ctx.slot, reason: 'E2E check-up' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body)); ctx.appt = r.body.data;
    assert.strictEqual(ctx.appt.departmentId, ctx.dept.id, 'defaults to primary department');
    const docList = await req('GET', '/doctor/appointments?scope=upcoming', { token: ctx.doctor.token });
    assert.ok(docList.body.data.items.some((a) => a.id === ctx.appt.id), 'visible in doctor portal');
    const adminList = await req('GET', `/admin/appointments?doctorId=${ctx.doctorId}`, { token: ctx.admin.token });
    assert.ok(adminList.body.data.items.some((a) => a.id === ctx.appt.id), 'visible in admin portal');
  });

  await test('double booking is prevented (sequential and concurrent)', async () => {
    const again = await req('POST', '/patient/appointments', { token: ctx.seedPatient.token, body: { doctorId: ctx.doctorId, startAt: ctx.slot } });
    assert.strictEqual(again.status, 409, 'same slot rejected');
    const p2 = (await req('POST', '/auth/register', { body: { email: `e2e.race.${stamp}@example.com`, password: 'Patient@123', fullName: 'Race Patient' } })).body;
    const [a, b] = await Promise.all([
      req('POST', '/patient/appointments', { token: ctx.seedPatient.token, body: { doctorId: ctx.doctorId, startAt: ctx.slot2 } }),
      req('POST', '/patient/appointments', { token: p2.token, body: { doctorId: ctx.doctorId, startAt: ctx.slot2 } }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepStrictEqual(statuses, [201, 409], `race result ${statuses}`);
    const slots = await req('GET', `/public/doctors/${ctx.doctorId}/slots?date=${ctx.date}`);
    assert.ok(slots.body.data.slots.find((s) => s.startAt === ctx.slot).booked, 'slot now shows as booked');
  });

  await test('doctor confirms → patient sees CONFIRMED and gets a notification', async () => {
    const r = await req('PATCH', `/doctor/appointments/${ctx.appt.id}/status`, { token: ctx.doctor.token, body: { status: 'CONFIRMED' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const list = await req('GET', '/patient/appointments?scope=upcoming', { token: ctx.patient.token });
    assert.strictEqual(list.body.data.items.find((a) => a.id === ctx.appt.id).status, 'CONFIRMED');
    const notes = await req('GET', '/notifications', { token: ctx.patient.token });
    assert.ok(notes.body.data.items.some((n) => n.title === 'Appointment confirmed'));
    const invalid = await req('PATCH', `/doctor/appointments/${ctx.appt.id}/status`, { token: ctx.doctor.token, body: { status: 'COMPLETED' } });
    assert.strictEqual(invalid.status, 400, 'cannot complete a future appointment');
  });

  await test('patient reschedules (back to PENDING) then admin approves', async () => {
    const r = await req('PATCH', `/patient/appointments/${ctx.appt.id}/reschedule`, { token: ctx.patient.token, body: { startAt: ctx.slot3 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.data.status, 'PENDING');
    const ap = await req('PATCH', `/admin/appointments/${ctx.appt.id}/status`, { token: ctx.admin.token, body: { status: 'CONFIRMED' } });
    assert.strictEqual(ap.status, 200); assert.strictEqual(ap.body.data.approvedByAdmin, true);
  });

  await test('doctor can view patient profile with allergies & history; unrelated doctor cannot', async () => {
    const r = await req('GET', `/doctor/patients/${ctx.patient.user.profile.id}`, { token: ctx.doctor.token });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.data.allergies.length, 2); assert.strictEqual(r.body.data.bloodGroup, 'O_NEG');
    const other = await login('rahul.verma@medicore.com', 'Doctor@123');
    ctx.otherDoctor = other;
    assert.strictEqual((await req('GET', `/doctor/patients/${ctx.patient.user.profile.id}`, { token: other.token })).status, 403);
  });

  await test('emergency workflow: routing, real-time alert, accept, duplicate-accept blocked, escalate, resolve', async () => {
    const docSocket = io(BASE, { auth: { token: ctx.doctor.token }, transports: ['websocket'] });
    const adminSocket = io(BASE, { auth: { token: ctx.admin.token }, transports: ['websocket'] });
    await Promise.all([new Promise((r) => docSocket.on('connect', r)), new Promise((r) => adminSocket.on('connect', r))]);
    // Keyword routes to our test department; CRITICAL also widens to emergency doctors
    const alert = waitForEvent(docSocket, 'emergency:alert');
    const adminNew = waitForEvent(adminSocket, 'emergency:new');
    const r = await req('POST', '/patient/emergencies', {
      token: ctx.patient.token,
      body: { priority: 'HIGH', symptoms: 'Patient reports zebra-test-symptom and dizziness', locationConsent: true, latitude: 40.71, longitude: -74.0 },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body)); ctx.em = r.body.data;
    assert.strictEqual(ctx.em.department.id, ctx.dept.id, 'department identified from symptoms');
    assert.strictEqual(ctx.em.status, 'NOTIFIED');
    await alert; await adminNew;
    const dup = await req('POST', '/patient/emergencies', { token: ctx.patient.token, body: { priority: 'LOW', symptoms: 'another one please' } });
    assert.strictEqual(dup.status, 409, 'only one active emergency per patient');
    const noConsent = await req('POST', '/patient/emergencies', { token: ctx.seedPatient.token, body: { priority: 'LOW', symptoms: 'location without consent', latitude: 1, longitude: 1 } });
    assert.strictEqual(noConsent.status, 400, 'location requires consent');

    const adminView = await req('GET', '/admin/emergencies?status=active', { token: ctx.admin.token });
    assert.ok(adminView.body.data.items.some((e) => e.id === ctx.em.id), 'admin sees emergency');
    const docView = await req('GET', '/doctor/emergencies?scope=active', { token: ctx.doctor.token });
    assert.ok(docView.body.data.some((e) => e.id === ctx.em.id), 'doctor sees emergency');

    const acc = await req('POST', `/doctor/emergencies/${ctx.em.id}/accept`, { token: ctx.doctor.token, body: { note: 'On my way' } });
    assert.strictEqual(acc.status, 200, JSON.stringify(acc.body)); assert.strictEqual(acc.body.data.status, 'ACCEPTED');
    const acc2 = await req('POST', `/doctor/emergencies/${ctx.em.id}/accept`, { token: ctx.otherDoctor.token, body: {} });
    assert.strictEqual(acc2.status, 409, 'second accept blocked');
    const pView = await req('GET', '/patient/emergencies', { token: ctx.patient.token });
    assert.strictEqual(pView.body.data.find((e) => e.id === ctx.em.id).status, 'ACCEPTED', 'patient sees status');

    const esc = await req('POST', `/doctor/emergencies/${ctx.em.id}/escalate`, { token: ctx.doctor.token, body: { reason: 'Needs neurology review' } });
    assert.strictEqual(esc.status, 200, JSON.stringify(esc.body));
    assert.strictEqual(esc.body.data.status, 'ESCALATED'); assert.strictEqual(esc.body.data.priority, 'CRITICAL'); assert.strictEqual(esc.body.data.escalationLevel, 1);
    assert.ok(esc.body.data.notifications.length > 1, 'escalation alerted more doctors');

    const assign = await req('PATCH', `/admin/emergencies/${ctx.em.id}`, { token: ctx.admin.token, body: { assignDoctorId: ctx.doctorId } });
    assert.strictEqual(assign.status, 200); assert.strictEqual(assign.body.data.status, 'ACCEPTED');
    const res = await req('POST', `/doctor/emergencies/${ctx.em.id}/resolve`, { token: ctx.doctor.token, body: { notes: 'Stabilised' } });
    assert.strictEqual(res.status, 200); assert.strictEqual(res.body.data.status, 'RESOLVED');
    assert.ok(res.body.data.events.length >= 6, 'timeline recorded');
    docSocket.close(); adminSocket.close();
  });

  await test('prescription: doctor issues, patient downloads PDF; other patient forbidden', async () => {
    const r = await req('POST', '/doctor/prescriptions', {
      token: ctx.doctor.token,
      body: { patientId: ctx.patient.user.profile.id, appointmentId: ctx.appt.id, diagnosis: 'Test diagnosis', items: [{ medicineName: 'Paracetamol', dosage: '500 mg', frequency: 'BID', durationDays: 5 }] },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body)); ctx.rx = r.body.data;
    const pdf = await req('GET', `/files/prescriptions/${ctx.rx.id}/pdf`, { token: ctx.patient.token, raw: true });
    assert.strictEqual(pdf.status, 200); assert.strictEqual(pdf.buffer.subarray(0, 4).toString(), '%PDF');
    assert.strictEqual((await req('GET', `/files/prescriptions/${ctx.rx.id}/pdf`, { token: ctx.seedPatient.token, raw: true })).status, 403);
  });

  await test('file upload: valid PDF accepted, spoofed file rejected, download authorised', async () => {
    const good = new FormData();
    good.append('file', new Blob([Buffer.from('%PDF-1.4\n%test\n')], { type: 'application/pdf' }), 'lab.pdf');
    good.append('title', 'Lab result'); good.append('reportType', 'LAB');
    const r = await req('POST', '/patient/reports', { token: ctx.patient.token, form: good });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body)); ctx.report = r.body.data;
    const bad = new FormData();
    bad.append('file', new Blob([Buffer.from('MZ\x90\x00not a pdf')], { type: 'application/pdf' }), 'evil.pdf');
    bad.append('title', 'Evil'); bad.append('reportType', 'LAB');
    assert.strictEqual((await req('POST', '/patient/reports', { token: ctx.patient.token, form: bad })).status, 400);
    const exe = new FormData();
    exe.append('file', new Blob([Buffer.from('MZ')], { type: 'application/x-msdownload' }), 'evil.exe');
    exe.append('title', 'Evil'); exe.append('reportType', 'LAB');
    assert.strictEqual((await req('POST', '/patient/reports', { token: ctx.patient.token, form: exe })).status, 400);
    const dl = await req('GET', `/files/reports/${ctx.report.id}`, { token: ctx.doctor.token, raw: true });
    assert.strictEqual(dl.status, 200);
    assert.strictEqual((await req('GET', `/files/reports/${ctx.report.id}`, { token: ctx.otherDoctor.token, raw: true })).status, 403);
    const docUp = new FormData();
    docUp.append('file', new Blob([Buffer.from('Consultation notes')], { type: 'text/plain' }), 'notes.txt');
    docUp.append('title', 'Consultation report'); docUp.append('reportType', 'CONSULTATION');
    assert.strictEqual((await req('POST', `/doctor/patients/${ctx.patient.user.profile.id}/reports`, { token: ctx.doctor.token, form: docUp })).status, 201);
  });

  await test('referral and department messaging', async () => {
    const colleagues = await req('GET', '/doctor/colleagues', { token: ctx.doctor.token });
    const to = colleagues.body.data.find((c) => c.specialization === 'Neurologist');
    const r = await req('POST', '/doctor/referrals', { token: ctx.doctor.token, body: { patientId: ctx.patient.user.profile.id, toDoctorId: to.id, reason: 'Neuro review' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const m = await req('POST', '/doctor/messages', { token: ctx.doctor.token, body: { toDepartmentId: ctx.cardiology.id, subject: 'Bed availability', body: 'Any free beds?' } });
    assert.strictEqual(m.status, 201, JSON.stringify(m.body));
  });

  await test('complaints: patient submits, admin responds, patient sees response', async () => {
    const c = await req('POST', '/complaints', { token: ctx.patient.token, body: { subject: 'Waiting time', description: 'Waited far too long at reception.', category: 'SERVICE' } });
    assert.strictEqual(c.status, 201);
    const r = await req('PATCH', `/admin/complaints/${c.body.data.id}/respond`, { token: ctx.admin.token, body: { response: 'Sorry — we are adding staff.', status: 'RESOLVED' } });
    assert.strictEqual(r.status, 200);
    const mine = await req('GET', '/complaints', { token: ctx.patient.token });
    assert.strictEqual(mine.body.data.items.find((x) => x.id === c.body.data.id).response, 'Sorry — we are adding staff.');
    const contact = await req('POST', '/public/contact', { body: { name: 'Visitor', email: 'visitor@example.com', subject: 'Parking', message: 'Is there parking on site?' } });
    assert.strictEqual(contact.status, 201);
  });

  await test('reviews: only completed appointments can be reviewed, once', async () => {
    const appts = await req('GET', '/patient/appointments?status=COMPLETED&limit=50', { token: ctx.seedPatient.token });
    const target = appts.body.data.items.find((a) => !a.review);
    if (!target) return; // seed may have reviewed all
    const r = await req('POST', '/patient/reviews', { token: ctx.seedPatient.token, body: { appointmentId: target.id, rating: 5, comment: 'Great' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual((await req('POST', '/patient/reviews', { token: ctx.seedPatient.token, body: { appointmentId: target.id, rating: 4 } })).status, 409);
    assert.strictEqual((await req('POST', '/patient/reviews', { token: ctx.patient.token, body: { appointmentId: ctx.appt.id, rating: 4 } })).status, 400);
  });

  await test('analytics reflect real records (admin + doctor) with filters', async () => {
    const all = await req('GET', '/admin/dashboard', { token: ctx.admin.token });
    assert.strictEqual(all.status, 200);
    const realDoctors = await req('GET', '/admin/doctors?status=active&limit=100', { token: ctx.admin.token });
    assert.strictEqual(all.body.data.totals.totalDoctors, realDoctors.body.data.pagination.total);
    const dept = await req('GET', `/admin/dashboard?departmentId=${ctx.dept.id}&from=2020-01-01&to=2030-12-31`, { token: ctx.admin.token });
    assert.strictEqual(dept.body.data.totals.emergencyCases, 1, 'department filter applies to emergencies');
    assert.ok(dept.body.data.totals.totalAppointments >= 2);
    const doc = await req('GET', '/doctor/dashboard?from=2020-01-01&to=2030-12-31', { token: ctx.doctor.token });
    assert.strictEqual(doc.status, 200); assert.strictEqual(doc.body.data.totals.emergencyCases, 1);
  });

  await test('reports: JSON and CSV export', async () => {
    const j = await req('GET', '/admin/reports/doctors', { token: ctx.admin.token });
    assert.strictEqual(j.status, 200); assert.ok(j.body.data.rows.length > 0);
    // reports that name patients need a recorded reason (details in tests/privacy.test.js)
    assert.strictEqual((await req('GET', '/admin/reports/appointments?format=csv', { token: ctx.admin.token, raw: true })).status, 400);
    const csv = await req('GET', '/admin/reports/appointments?format=csv', { token: ctx.admin.token, raw: true, reason: 'Monthly appointment audit' });
    assert.strictEqual(csv.status, 200); assert.ok(csv.headers.get('content-type').includes('text/csv'));
  });

  await test('admin: deactivate user blocks login; broadcast notification; audit log entries', async () => {
    const users = await req('GET', `/admin/users?search=e2e.race.${stamp}`, { token: ctx.admin.token });
    const u = users.body.data.items[0];
    assert.strictEqual((await req('PATCH', `/admin/users/${u.id}/status`, { token: ctx.admin.token, body: { isActive: false } })).status, 200);
    assert.strictEqual((await req('POST', '/auth/login', { body: { email: `e2e.race.${stamp}@example.com`, password: 'Patient@123' } })).status, 403);
    const b = await req('POST', '/admin/notifications/broadcast', { token: ctx.admin.token, body: { title: 'Maintenance', message: 'Tonight 2am', audience: 'DOCTOR' } });
    assert.strictEqual(b.status, 201); assert.ok(b.body.data.recipients > 10);
    const logs = await req('GET', '/admin/audit-logs?action=EMERGENCY', { token: ctx.admin.token });
    assert.ok(logs.body.data.items.length > 0);
  });

  await test('cleanup: delete test doctor and department (soft deletion: rows kept)', async () => {
    const r = await req('DELETE', `/admin/doctors/${ctx.doctorId}`, { token: ctx.admin.token });
    assert.strictEqual(r.status, 200); assert.ok(/deleted/.test(r.body.message) && /restore/.test(r.body.message));
    const d = await req('DELETE', `/admin/departments/${ctx.dept.id}`, { token: ctx.admin.token });
    assert.strictEqual(d.status, 200);
    // soft deletion: both rows still exist, and can be restored by an admin (details in tests/softdelete.test.js)
    assert.strictEqual((await req('GET', `/admin/doctors/${ctx.doctorId}`, { token: ctx.admin.token })).status, 200);
  });

  console.log(results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
