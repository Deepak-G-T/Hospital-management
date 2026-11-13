/* eslint-disable no-console */
// Architecture checks for the service layer (P1): layering rules, password service, shared selects and the
// patient-access policy. Database checks only run against a disposable *_test database:
//   DATABASE_URL=postgresql://…/smart_hospital_test npm run test:architecture
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0; let failed = 0; let skipped = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(`  ✔ ${name}`); } catch (e) { failed += 1; results.push(`  ✘ ${name}\n      ${e.message}`); }
}
const skip = (name, why) => { skipped += 1; results.push(`  ○ ${name} (skipped: ${why})`); };
const SRC = path.join(__dirname, '../src');
const controllers = fs.readdirSync(path.join(SRC, 'controllers')).filter((f) => f.endsWith('.js'));

(async () => {
  // ── Layering ──
  await test('no controller talks to the database directly (no Prisma import)', () => {
    const offenders = controllers.filter((f) => /require\(['"][./]*config\/prisma['"]\)|@prisma\/client/.test(fs.readFileSync(path.join(SRC, 'controllers', f), 'utf8')));
    assert.deepStrictEqual(offenders, []);
  });
  await test('controllers do not import other controllers', () => {
    const offenders = controllers.filter((f) => /require\(['"]\.\/[a-zA-Z]+\.controller['"]\)/.test(fs.readFileSync(path.join(SRC, 'controllers', f), 'utf8')));
    assert.deepStrictEqual(offenders, []);
  });
  await test('services and policies never import controllers', () => {
    const dirs = ['services', 'policies', 'db'];
    const offenders = dirs.flatMap((d) => fs.readdirSync(path.join(SRC, d)).filter((f) => /controller/.test(fs.readFileSync(path.join(SRC, d, f), 'utf8').match(/require\([^)]*\)/g)?.join(' ') || '')).map((f) => `${d}/${f}`));
    assert.deepStrictEqual(offenders, []);
  });

  // ── Password service ──
  const { hashPassword, verifyPassword, SALT_ROUNDS } = require('../src/services/password.service');
  await test('password service: bcrypt hash with 12 rounds, verifies right/wrong passwords', async () => {
    assert.strictEqual(SALT_ROUNDS, 12);
    const hash = await hashPassword('Secret@123');
    assert.ok(hash.startsWith('$2') && hash.includes('$12$'));
    assert.strictEqual(await verifyPassword('Secret@123', hash), true);
    assert.strictEqual(await verifyPassword('Wrong@123', hash), false);
  });
  await test('password service: unknown account (no hash) is rejected but still takes bcrypt time', async () => {
    const t = Date.now();
    assert.strictEqual(await verifyPassword('anything', null), false);
    assert.ok(Date.now() - t >= 20, 'should spend comparable time to a real check');
  });

  // ── Shared selects ──
  await test('shared selects are frozen (cannot be changed by one caller for everyone)', () => {
    const selects = require('../src/db/selects');
    for (const [name, value] of Object.entries(selects)) {
      assert.ok(Object.isFrozen(value), `${name} is not frozen`);
      assert.ok(value.select && typeof value.select === 'object', `${name} is not a relation select`);
    }
  });

  // ── Retention: records are soft-deleted, never removed ──
  await test('no service hard-deletes clinical, account or audit data (soft deletion only)', () => {
    const protectedModels = 'patientMedicalRecord|allergy|medicalReport|doctor|department|user|patient|appointment|prescription|prescriptionItem|emergencyRequest|emergencyEvent|emergencyNotification|referral|doctorReview|auditLog';
    const hard = new RegExp(`\\.(${protectedModels})\\.(delete|deleteMany)\\(|DELETE FROM|TRUNCATE`, 'i');
    const offenders = [];
    for (const dir of ['services', 'controllers', 'policies', 'workers']) {
      const d = path.join(SRC, dir);
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.js'))) if (hard.test(fs.readFileSync(path.join(d, f), 'utf8'))) offenders.push(`${dir}/${f}`);
    }
    assert.deepStrictEqual(offenders, [], 'hard delete found — use soft deletion (services/softDelete.service.js)');
  });
  await test('application code only ever INSERTS audit rows (no update, upsert or delete of audit_logs)', () => {
    const bad = /auditLog\.(update|updateMany|upsert|delete|deleteMany)\(|(UPDATE|DELETE FROM|TRUNCATE)\s+"?audit_logs/i;
    const offenders = [];
    for (const dir of ['services', 'controllers', 'policies', 'workers', 'middleware', 'routes']) {
      const d = path.join(SRC, dir);
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.js'))) if (bad.test(fs.readFileSync(path.join(d, f), 'utf8'))) offenders.push(`${dir}/${f}`);
    }
    assert.deepStrictEqual(offenders, [], 'the audit log is append-only');
  });

  // ── Patient-access policy (needs a disposable test database) ──
  if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
    skip('patient-access policy against real data', 'set DATABASE_URL to a *_test database');
  } else {
    const prisma = require('../src/config/prisma');
    const policy = require('../src/policies/patientAccess');
    // The rule before Item 7: ANY appointment, emergency alert or referral, ever. The new rule may only be narrower.
    const oldRule = async (doctorId, patientId) => {
      const [appt, em, ref] = await Promise.all([
        prisma.appointment.findFirst({ where: { doctorId, patientId }, select: { id: true } }),
        prisma.emergencyRequest.findFirst({ where: { patientId, OR: [{ assignedDoctorId: doctorId }, { notifications: { some: { doctorId } } }] }, select: { id: true } }),
        prisma.referral.findFirst({ where: { patientId, OR: [{ toDoctorId: doctorId }, { fromDoctorId: doctorId }] }, select: { id: true } }),
      ]);
      return Boolean(appt || em || ref);
    };
    const doctors = await prisma.doctor.findMany({ select: { id: true }, take: 6 });
    const patients = await prisma.patient.findMany({ select: { id: true }, take: 40 });

    await test(`new policy never grants more than the old one, and is narrower somewhere (${doctors.length * patients.length} pairs)`, async () => {
      let kept = 0; let narrowed = 0;
      for (const d of doctors) {
        for (const p of patients) {
          const now = (await policy.doctorAccess(d.id, p.id)).level !== 'NONE';
          const before = await oldRule(d.id, p.id);
          assert.ok(!now || before, `doctor ${d.id} gained access to patient ${p.id}`);
          if (now) kept += 1; else if (before) narrowed += 1;
        }
      }
      assert.ok(kept > 0 && narrowed > 0, `sample should contain both outcomes (kept ${kept}, narrowed ${narrowed})`);
    });
    await test('the doctor\'s patient list uses exactly the same rule as the single-patient check', async () => {
      for (const d of doctors) {
        const listed = new Set((await prisma.patient.findMany({ where: policy.careRelationshipWhere(d.id), select: { id: true } })).map((p) => p.id));
        for (const p of patients) assert.strictEqual(listed.has(p.id), (await policy.doctorAccess(d.id, p.id)).level !== 'NONE', `doctor ${d.id} / patient ${p.id}`);
      }
    });
    await test('the doctor-list shortcut (treatmentPatientIds) agrees with the full policy for every doctor/patient pair', async () => {
      for (const d of doctors) {
        const treating = await policy.treatmentPatientIds(d.id);
        for (const p of patients) {
          const a = await policy.doctorAccess(d.id, p.id);
          assert.strictEqual(treating.has(p.id), a.sections.allergies === true, `doctor ${d.id} / patient ${p.id} (level ${a.level})`);
        }
      }
    });
    await test('authorizeChart: patient only self, admin only with a reason, doctor only with a relationship', async () => {
      const [a, b] = patients;
      await policy.authorizeChart({ role: 'PATIENT', profileId: a.id }, a.id);
      await assert.rejects(policy.authorizeChart({ role: 'PATIENT', profileId: a.id }, b.id), /permission/);
      await assert.rejects(policy.authorizeChart({ role: 'ADMIN', id: 'x' }, a.id), (e) => e.statusCode === 400 && e.details.code === 'REASON_REQUIRED');
      await assert.rejects(policy.authorizeChart({ role: 'ADMIN', id: 'x', accessReason: 'short' }, a.id), (e) => e.details.code === 'REASON_REQUIRED');
      await assert.rejects(policy.authorizeChart({ role: 'ADMIN', id: 'x', accessReason: '   ' }, a.id), (e) => e.details.code === 'REASON_REQUIRED');
      await assert.rejects(policy.authorizeChart({ role: 'ADMIN', id: 'x', accessReason: 'x'.repeat(501) }, a.id), (e) => e.details.code === 'REASON_REQUIRED');
      await assert.rejects(policy.authorizeChart({ role: 'DOCTOR', id: 'x', profileId: doctors[0].id }, '00000000-0000-0000-0000-000000000000'), /access/);
      await assert.rejects(policy.authorizeChart({ role: 'NOBODY' }, a.id), /permission/);
    });
    await test('every service that reads or writes clinical data goes through the policy', () => {
      const need = { 'medicalReport.service.js': ['authorizeItem', 'authorizeWrite'], 'prescription.service.js': ['authorizeItem', 'authorizeWrite'], 'medicalRecord.service.js': ['authorizeWrite'], 'doctorPortal.service.js': ['authorizeChart', 'authorizeWrite'], 'patientAdmin.service.js': ['authorizeChart'], 'emergency.service.js': ['requireReason'] };
      for (const [file, fns] of Object.entries(need)) {
        const src = fs.readFileSync(path.join(SRC, 'services', file), 'utf8');
        for (const fn of fns) assert.ok(src.includes(fn), `${file} must use ${fn}`);
      }
      // the old any-link helpers are gone, so nothing can still call them
      for (const dir of ['services', 'controllers', 'routes']) {
        for (const f of fs.readdirSync(path.join(SRC, dir)).filter((x) => x.endsWith('.js'))) {
          assert.ok(!/assertDoctorCanAccessPatient|hasCareRelationship/.test(fs.readFileSync(path.join(SRC, dir, f), 'utf8')), `${dir}/${f} uses a removed helper`);
        }
      }
    });
    await prisma.$disconnect();
  }

  console.log(results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(failed ? 1 : 0);
})();
