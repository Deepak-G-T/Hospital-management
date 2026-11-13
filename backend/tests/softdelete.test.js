/* eslint-disable no-console */
// P1 item 8 — soft deletion. Needs the API and its disposable *_test database:
//   API_URL=http://localhost:5001 DATABASE_URL=…/smart_hospital_test npm run test:softdelete
// Patients' deleted allergies / history entries / reports, and admins' deleted doctors / departments, are kept (never removed),
// hidden from ordinary views, still visible (flagged) to treating clinicians, restorable by the right people, and audited.
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const DB_URL = process.env.DATABASE_URL || '';
if (!/_test(\?|$)/.test(DB_URL)) { console.log('Skipped: set DATABASE_URL to a disposable *_test database'); process.exit(0); }
const BASE = process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`;
const API = `${BASE}/api`;
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
const { REPORT_DIR } = require('../src/middleware/upload');

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
  if (raw) { await res.arrayBuffer(); return { status: res.status }; }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, data: json && json.data };
}
async function login(email, password) { const r = await req('POST', '/auth/login', { body: { email, password } }); assert.strictEqual(r.status, 200, `${email}: ${JSON.stringify(r.body)}`); return { token: r.body.token, user: r.body.user }; }
const tag = () => crypto.randomBytes(4).toString('hex');
async function newPatient(label) {
  const r = await req('POST', '/auth/register', { body: { email: `sd.${label}.${Date.now()}.${tag()}@example.com`, password: 'Start@1234', fullName: `SoftDel ${label}` } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const p = await db.patient.findUnique({ where: { userId: r.body.user.id } });
  return { id: p.id, userId: r.body.user.id, token: r.body.token };
}
const counts = async () => ({
  allergies: await db.allergy.count(), records: await db.patientMedicalRecord.count(), reports: await db.medicalReport.count(),
  doctors: await db.doctor.count(), departments: await db.department.count(), users: await db.user.count(), appointments: await db.appointment.count(),
  prescriptions: await db.prescription.count(), audit: await db.auditLog.count(),
});
const REASON = 'Restoring an item at the patient\'s request';

(async () => {
  const before = await counts();
  const t0 = new Date();
  const admin = await login('admin@medicore.com', 'Admin@123');
  const D1u = await db.user.findUnique({ where: { email: 'david.chen@medicore.com' }, include: { doctor: true } });
  const D1 = { id: D1u.doctor.id, userId: D1u.id };
  const doc1 = await login('david.chen@medicore.com', 'Doctor@123');
  const doc3 = await login('sarah.mitchell@medicore.com', 'Doctor@123');
  const dept = await db.department.findFirst({ where: { name: 'Cardiology' } });

  const P = await newPatient('p'); const Q = await newPatient('q');
  // D1 treats P (confirmed appointment in a week) → treatment access
  await db.appointment.create({ data: { patientId: P.id, doctorId: D1.id, departmentId: dept.id, status: 'CONFIRMED', type: 'CONSULTATION', reason: 'soft delete test', startAt: new Date(Date.now() + 7 * 86400000), endAt: new Date(Date.now() + 7 * 86400000 + 1800000) } });
  const chart = (tok = doc1.token) => req('GET', `/doctor/patients/${P.id}`, { token: tok });

  // ═══════════ Allergies ═══════════
  const allergy = (await req('POST', '/patient/allergies', { token: P.token, body: { allergen: 'Penicillin-SD', type: 'DRUG', severity: 'SEVERE' } })).data;
  await test('ALLERGY · patient delete is soft: row kept with who/when, hidden from the patient, listed under "deleted"', async () => {
    const r = await req('DELETE', `/patient/allergies/${allergy.id}`, { token: P.token });
    assert.strictEqual(r.status, 200);
    const row = await db.allergy.findUnique({ where: { id: allergy.id } });
    assert.ok(row && row.deletedAt && row.deletedByUserId === P.userId, 'row kept, marked');
    assert.ok(!(await req('GET', '/patient/allergies', { token: P.token })).data.some((a) => a.id === allergy.id));
    assert.ok((await req('GET', '/patient/allergies?deleted=true', { token: P.token })).data.some((a) => a.id === allergy.id));
    assert.ok(!JSON.stringify((await req('GET', '/patient/dashboard', { token: P.token })).data.allergies).includes('Penicillin-SD'), 'dashboard');
    assert.strictEqual((await req('DELETE', `/patient/allergies/${allergy.id}`, { token: P.token })).status, 404, 'second delete');
    assert.strictEqual((await req('PUT', `/patient/allergies/${allergy.id}`, { token: P.token, body: { allergen: 'x', type: 'DRUG', severity: 'MILD' } })).status, 404, 'cannot edit a deleted one');
  });
  await test('ALLERGY · a treating doctor still sees it, flagged; admins and emergency payloads do not', async () => {
    const a = (await chart()).data.allergies.find((x) => x.id === allergy.id);
    assert.ok(a && a.deletedAt, 'flagged as removed by the patient');
    const adm = await req('GET', `/admin/patients/${P.id}`, { token: admin.token, reason: 'Checking the allergy list' });
    assert.ok(!adm.data.allergies.some((x) => x.id === allergy.id), 'admin detail');
    const em = await db.emergencyRequest.create({ data: { patientId: P.id, priority: 'HIGH', status: 'NOTIFIED', symptoms: 'soft delete test', autoEscalationEnabled: false } });
    await db.emergencyNotification.create({ data: { emergencyId: em.id, doctorId: D1.id } });
    const board = (await req('GET', '/doctor/emergencies?scope=active', { token: doc1.token })).data.find((e) => e.id === em.id);
    assert.ok(board && board.patient.allergies.length === 0, 'emergency payload lists active allergies only');
    await db.emergencyRequest.update({ where: { id: em.id }, data: { status: 'CANCELLED' } });
  });
  await test('ALLERGY · only the owner can restore; restoring brings it back everywhere', async () => {
    assert.strictEqual((await req('POST', `/patient/allergies/${allergy.id}/restore`, { token: Q.token })).status, 404, 'another patient');
    assert.strictEqual((await req('POST', `/patient/allergies/${allergy.id}/restore`, { token: doc1.token })).status, 403, 'a doctor');
    assert.strictEqual((await req('POST', `/patient/allergies/${allergy.id}/restore`, {})).status, 401);
    assert.strictEqual((await req('DELETE', `/patient/allergies/${allergy.id}`, { token: Q.token })).status, 404, 'another patient cannot delete it either');
    assert.strictEqual((await req('POST', `/patient/allergies/${allergy.id}/restore`, { token: P.token })).status, 200);
    const row = await db.allergy.findUnique({ where: { id: allergy.id } });
    assert.ok(!row.deletedAt && !row.deletedByUserId);
    assert.ok((await req('GET', '/patient/allergies', { token: P.token })).data.some((a) => a.id === allergy.id));
    assert.strictEqual((await chart()).data.allergies.find((x) => x.id === allergy.id).deletedAt, null);
    assert.strictEqual((await req('POST', `/patient/allergies/${allergy.id}/restore`, { token: P.token })).status, 404, 'nothing left to restore');
  });

  // ═══════════ Medical history ═══════════
  const rec = (await req('POST', '/patient/medical-records', { token: P.token, body: { recordType: 'CONDITION', title: 'Asthma-SD' } })).data;
  const docRec = (await req('POST', `/doctor/patients/${P.id}/records`, { token: doc1.token, body: { recordType: 'DIAGNOSIS', title: 'DoctorDx-SD' } })).data;
  await test('HISTORY · patient delete is soft; doctor-written entries cannot be deleted by the patient', async () => {
    assert.strictEqual((await req('DELETE', `/patient/medical-records/${rec.id}`, { token: P.token })).status, 200);
    assert.ok((await db.patientMedicalRecord.findUnique({ where: { id: rec.id } })).deletedAt, 'row kept');
    assert.ok(!(await req('GET', '/patient/medical-records', { token: P.token })).data.some((r) => r.id === rec.id));
    assert.ok((await req('GET', '/patient/medical-records?deleted=true', { token: P.token })).data.some((r) => r.id === rec.id));
    const d = await req('DELETE', `/patient/medical-records/${docRec.id}`, { token: P.token });
    assert.strictEqual(d.status, 403); assert.ok(!(await db.patientMedicalRecord.findUnique({ where: { id: docRec.id } })).deletedAt);
    assert.strictEqual((await req('PUT', `/patient/medical-records/${rec.id}`, { token: P.token, body: { recordType: 'CONDITION', title: 'edit' } })).status, 404);
    assert.ok((await chart()).data.medicalRecords.find((r) => r.id === rec.id).deletedAt, 'treating doctor still sees it, flagged');
    assert.ok(!(await req('GET', `/admin/patients/${P.id}`, { token: admin.token, reason: 'Checking the history list' })).data.medicalRecords.some((r) => r.id === rec.id), 'admin does not');
  });
  await test('HISTORY · admin restore needs a recorded reason, is audited first, and authorisation is enforced', async () => {
    const url = `/admin/restore/records/${rec.id}`;
    for (const reason of [undefined, '', 'short']) { const r = await req('POST', url, { token: admin.token, reason }); assert.strictEqual(r.status, 400); assert.strictEqual(r.body.details.code, 'REASON_REQUIRED'); }
    assert.ok((await db.patientMedicalRecord.findUnique({ where: { id: rec.id } })).deletedAt, 'still deleted after refused attempts');
    for (const tok of [P.token, doc1.token]) assert.strictEqual((await req('POST', url, { token: tok, reason: REASON })).status, 403);
    assert.strictEqual((await req('POST', `/admin/restore/records/${crypto.randomUUID()}`, { token: admin.token, reason: REASON })).status, 404);
    assert.strictEqual((await req('POST', '/admin/restore/prescriptions/' + rec.id, { token: admin.token, reason: REASON })).status, 400, 'only the three kinds');
    assert.strictEqual((await req('POST', url, { token: admin.token, reason: REASON })).status, 200);
    assert.ok(!(await db.patientMedicalRecord.findUnique({ where: { id: rec.id } })).deletedAt);
    const log = await db.auditLog.findFirst({ where: { action: 'MEDICAL_ITEM_RESTORED', userId: admin.user.id, createdAt: { gte: t0 } } });
    assert.ok(log && log.details.reason === REASON && log.details.itemId === rec.id && log.details.kind === 'records');
    assert.strictEqual((await req('POST', url, { token: admin.token, reason: REASON })).status, 404, 'not deleted any more');
  });

  // ═══════════ Reports (files stay on disk) ═══════════
  const storedName = `sd-test-${tag()}.pdf`;
  fs.writeFileSync(path.join(REPORT_DIR, storedName), '%PDF-1.4\n%soft delete test\n');
  const rep = await db.medicalReport.create({ data: { patientId: P.id, uploadedByUserId: P.userId, title: 'Lab-SD', reportType: 'LAB', fileName: 'lab.pdf', storedName, mimeType: 'application/pdf', fileSize: 30 } });
  const docStored = `sd-test-${tag()}.pdf`; fs.writeFileSync(path.join(REPORT_DIR, docStored), '%PDF-1.4\n%x\n');
  const docRep = await db.medicalReport.create({ data: { patientId: P.id, doctorId: D1.id, uploadedByUserId: D1.userId, title: 'DoctorReport-SD', reportType: 'LAB', fileName: 'd.pdf', storedName: docStored, mimeType: 'application/pdf', fileSize: 14 } });
  const dl = (id, tok, reason) => req('GET', `/files/reports/${id}`, { token: tok, reason, raw: true });
  await test('REPORT · delete keeps the row AND the file; patient and admin can no longer download, the treating doctor can', async () => {
    assert.strictEqual((await dl(rep.id, P.token)).status, 200, 'before');
    assert.strictEqual((await req('DELETE', `/patient/reports/${rep.id}`, { token: P.token })).status, 200);
    assert.ok((await db.medicalReport.findUnique({ where: { id: rep.id } })).deletedAt, 'row kept');
    assert.ok(fs.existsSync(path.join(REPORT_DIR, storedName)), 'file kept on disk');
    assert.ok(!(await req('GET', '/patient/reports', { token: P.token })).data.items.some((r) => r.id === rep.id));
    assert.ok((await req('GET', '/patient/reports?deleted=true', { token: P.token })).data.items.some((r) => r.id === rep.id));
    assert.strictEqual((await dl(rep.id, P.token)).status, 404, 'patient');
    assert.strictEqual((await dl(rep.id, admin.token, 'Checking a patient complaint')).status, 404, 'admin');
    assert.strictEqual((await dl(rep.id, doc1.token)).status, 200, 'treating doctor keeps access');
    assert.ok((await chart()).data.medicalReports.find((r) => r.id === rep.id).deletedAt, 'flagged in the chart');
    assert.strictEqual((await dl(rep.id, doc3.token)).status, 403, 'an unrelated doctor still has none');
    assert.strictEqual((await req('DELETE', `/patient/reports/${docRep.id}`, { token: P.token })).status, 403, 'doctor-uploaded reports cannot be deleted');
    assert.strictEqual((await req('POST', `/patient/reports/${rep.id}/restore`, { token: Q.token })).status, 404);
    assert.strictEqual((await req('POST', `/patient/reports/${rep.id}/restore`, { token: P.token })).status, 200);
    assert.strictEqual((await dl(rep.id, P.token)).status, 200, 'after restore');
  });

  // ═══════════ Doctors ═══════════
  const stamp = Date.now();
  const newDoctor = async () => {
    const r = await req('POST', '/admin/doctors', { token: admin.token, body: { email: `sd.doctor.${stamp}.${tag()}@medicore.com`, password: 'Doctor@123', fullName: 'SoftDel Doctor', specialization: 'Test Medicine', licenseNumber: `SD-${tag()}`, consultationFee: 50, experienceYears: 3, departmentIds: [dept.id], primaryDepartmentId: dept.id } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return { ...r.data, email: r.body.data.user?.email || r.data.email };
  };
  await test('DOCTOR · delete is soft even without history: rows kept, hidden from lists and directory, login blocked, audited', async () => {
    const d = await newDoctor(); const u = await db.doctor.findUnique({ where: { id: d.id }, include: { user: true } });
    const r = await req('DELETE', `/admin/doctors/${d.id}`, { token: admin.token });
    assert.strictEqual(r.status, 200); assert.match(r.body.message, /restore/);
    const row = await db.doctor.findUnique({ where: { id: d.id }, include: { user: true } });
    assert.ok(row && row.deletedAt && row.deletedByUserId === admin.user.id && row.user.isActive === false, 'doctor and user rows kept');
    assert.ok(!(await req('GET', '/admin/doctors?limit=100&search=SoftDel', { token: admin.token })).data.items.some((x) => x.id === d.id), 'hidden from the default list');
    assert.ok((await req('GET', '/admin/doctors?limit=100&status=deleted', { token: admin.token })).data.items.some((x) => x.id === d.id), 'listed under deleted');
    assert.strictEqual((await req('GET', `/admin/doctors/${d.id}`, { token: admin.token })).status, 200, 'detail still reachable');
    assert.ok(!JSON.stringify((await req('GET', '/public/doctors', {})).body).includes(d.id), 'public directory');
    assert.strictEqual((await req('POST', '/auth/login', { body: { email: u.user.email, password: 'Doctor@123' } })).status, 403, 'login blocked');
    assert.strictEqual((await req('DELETE', `/admin/doctors/${d.id}`, { token: admin.token })).status, 404, 'double delete');
    assert.ok(await db.auditLog.findFirst({ where: { action: 'DOCTOR_DELETED', entityId: d.id, userId: admin.user.id } }), 'audited');
    // restore
    for (const tok of [doc1.token, P.token]) assert.strictEqual((await req('POST', `/admin/doctors/${d.id}/restore`, { token: tok })).status, 403, 'only admins restore');
    assert.strictEqual((await req('POST', `/admin/doctors/${d.id}/restore`, { token: admin.token })).status, 200);
    assert.ok((await req('GET', '/admin/doctors?limit=100&status=active&search=SoftDel', { token: admin.token })).data.items.some((x) => x.id === d.id));
    assert.strictEqual((await req('POST', '/auth/login', { body: { email: u.user.email, password: 'Doctor@123' } })).status, 200, 'can log in again');
    assert.strictEqual((await req('POST', `/admin/doctors/${d.id}/restore`, { token: admin.token })).status, 404, 'not deleted');
    assert.ok(await db.auditLog.findFirst({ where: { action: 'DOCTOR_RESTORED', entityId: d.id } }));
    for (const tok of [doc1.token, P.token]) assert.strictEqual((await req('DELETE', `/admin/doctors/${d.id}`, { token: tok })).status, 403, 'only admins delete');
  });
  await test('DOCTOR · a doctor with history: appointments and prescriptions stay intact, only future ones are cancelled', async () => {
    const d = await newDoctor();
    const past = await db.appointment.create({ data: { patientId: Q.id, doctorId: d.id, departmentId: dept.id, status: 'COMPLETED', type: 'CONSULTATION', diagnosis: 'DX-keep', startAt: new Date(Date.now() - 20 * 86400000), endAt: new Date(Date.now() - 20 * 86400000 + 1800000) } });
    const future = await db.appointment.create({ data: { patientId: Q.id, doctorId: d.id, departmentId: dept.id, status: 'CONFIRMED', type: 'CONSULTATION', startAt: new Date(Date.now() + 9 * 86400000), endAt: new Date(Date.now() + 9 * 86400000 + 1800000) } });
    const rx = await db.prescription.create({ data: { prescriptionNumber: `RX-SD-${tag()}`.toUpperCase(), patientId: Q.id, doctorId: d.id, appointmentId: past.id, diagnosis: 'Rx-keep', items: { create: [{ medicineName: 'M', dosage: '1', frequency: 'd', durationDays: 1 }] } } });
    assert.strictEqual((await req('DELETE', `/admin/doctors/${d.id}`, { token: admin.token })).status, 200);
    assert.strictEqual((await db.appointment.findUnique({ where: { id: past.id } })).status, 'COMPLETED');
    assert.strictEqual((await db.appointment.findUnique({ where: { id: past.id } })).diagnosis, 'DX-keep');
    assert.strictEqual((await db.appointment.findUnique({ where: { id: future.id } })).status, 'CANCELLED');
    assert.ok(await db.prescription.findUnique({ where: { id: rx.id } }));
    const mine = (await req('GET', '/patient/appointments?scope=past&limit=100', { token: Q.token })).data.items.find((a) => a.id === past.id);
    assert.strictEqual(mine.doctor.fullName, 'SoftDel Doctor', 'history still shows the doctor\'s name');
    assert.strictEqual((await req('GET', `/files/prescriptions/${rx.id}/pdf`, { token: Q.token, raw: true })).status, 200, 'prescription PDF still works');
    assert.strictEqual((await req('POST', `/admin/doctors/${d.id}/restore`, { token: admin.token })).status, 200);
    assert.strictEqual((await db.appointment.findUnique({ where: { id: future.id } })).status, 'CANCELLED', 'cancelled appointments are not resurrected');
  });

  // ═══════════ Departments ═══════════
  await test('DEPARTMENT · delete is soft (with or without history); hidden from lists and the directory; restore is admin-only', async () => {
    const mk = async () => { const r = await req('POST', '/admin/departments', { token: admin.token, body: { name: `SD Dept ${tag()}`, description: 'x', keywords: 'sd', icon: 'Stethoscope' } }); assert.strictEqual(r.status, 201); return r.data; };
    const empty = await mk(); const used = await mk();
    const appt = await db.appointment.create({ data: { patientId: Q.id, doctorId: D1.id, departmentId: used.id, status: 'COMPLETED', type: 'CONSULTATION', startAt: new Date(Date.now() - 30 * 86400000), endAt: new Date(Date.now() - 30 * 86400000 + 1800000) } });
    for (const d of [empty, used]) {
      assert.strictEqual((await req('DELETE', `/admin/departments/${d.id}`, { token: admin.token })).status, 200);
      const row = await db.department.findUnique({ where: { id: d.id } });
      assert.ok(row && row.deletedAt && row.isActive === false, 'row kept');
      assert.ok(!(await req('GET', '/admin/departments', { token: admin.token })).data.some((x) => x.id === d.id), 'hidden');
      assert.ok((await req('GET', '/admin/departments?deleted=true', { token: admin.token })).data.some((x) => x.id === d.id), 'listed as deleted');
      assert.ok(!JSON.stringify((await req('GET', '/public/departments', {})).body).includes(d.id), 'public directory');
      assert.strictEqual((await req('DELETE', `/admin/departments/${d.id}`, { token: admin.token })).status, 404);
      for (const tok of [doc1.token, P.token]) { assert.strictEqual((await req('POST', `/admin/departments/${d.id}/restore`, { token: tok })).status, 403); assert.strictEqual((await req('DELETE', `/admin/departments/${d.id}`, { token: tok })).status, 403); }
      assert.ok(await db.auditLog.findFirst({ where: { action: 'DEPARTMENT_DELETED', entityId: d.id } }));
    }
    assert.ok(await db.appointment.findUnique({ where: { id: appt.id } }), 'appointment history intact');
    assert.strictEqual((await db.appointment.findUnique({ where: { id: appt.id }, include: { department: true } })).department.id, used.id, 'still linked to its department');
    assert.strictEqual((await req('POST', `/admin/departments/${used.id}/restore`, { token: admin.token })).status, 200);
    assert.ok((await req('GET', '/admin/departments', { token: admin.token })).data.some((x) => x.id === used.id));
    assert.strictEqual((await db.department.findUnique({ where: { id: used.id } })).isActive, true);
    assert.ok(await db.auditLog.findFirst({ where: { action: 'DEPARTMENT_RESTORED', entityId: used.id } }));
  });

  // ═══════════ Retention ═══════════
  await test('RETENTION · after all deletions no row of any protected table has disappeared and no audit entry was removed', async () => {
    const after = await counts();
    for (const k of Object.keys(before)) assert.ok(after[k] >= before[k], `${k}: ${before[k]} → ${after[k]}`);
    assert.ok(after.audit > before.audit, 'deletions and restores were audited');
    const names = (await db.auditLog.findMany({ where: { createdAt: { gte: t0 } }, select: { action: true } })).map((a) => a.action);
    for (const a of ['ALLERGY_DELETED', 'ALLERGY_RESTORED', 'MEDICAL_RECORD_DELETED', 'MEDICAL_ITEM_RESTORED', 'REPORT_DELETED', 'REPORT_RESTORED', 'DOCTOR_DELETED', 'DOCTOR_RESTORED', 'DEPARTMENT_DELETED', 'DEPARTMENT_RESTORED']) assert.ok(names.includes(a), `${a} audited`);
  });

  for (const f of fs.readdirSync(REPORT_DIR).filter((x) => x.startsWith('sd-test-'))) fs.unlink(path.join(REPORT_DIR, f), () => {});
  console.log(results.join('\n'));
  console.log(`\nSoft-deletion tests: ${passed} passed, ${failed} failed`);
  await db.$disconnect();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Soft-deletion suite crashed:', e); process.exit(1); });
