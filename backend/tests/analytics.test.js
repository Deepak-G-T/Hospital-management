/* eslint-disable no-console */
// Analytics regression test: the SQL implementation (services/analytics.service.js) must return exactly what the previous
// in-memory implementation returned (tests/reference/analytics.reference.js) — every total, series, trend bucket and rating.
// Needs a disposable *_test database. Run under several timezones, e.g.:
//   DATABASE_URL=…/smart_hospital_test TZ=America/New_York npm run test:analytics
require('dotenv').config({ quiet: true });
const assert = require('assert');

let passed = 0; let failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(`  ✔ ${name}`); } catch (e) { failed += 1; results.push(`  ✘ ${name}\n      ${e.message.split('\n').slice(0, 8).join('\n      ')}`); }
}

(async () => {
  if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
    console.log('Skipped: set DATABASE_URL to a disposable *_test database'); process.exit(0);
  }
  const prisma = require('../src/config/prisma');
  const sql = require('../src/services/analytics.service');
  const reference = require('./reference/analytics.reference');
  const { resolveRange, startOfDay, endOfDay, addDays } = require('../src/utils/dates');
  const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const today = new Date();
  const ranges = {
    'default 30 days': resolveRange({}, 30),
    '7 days': resolveRange({}, 7),
    '92 days (last daily range)': { from: startOfDay(addDays(today, -91)), to: endOfDay(today) },
    '93 days (first monthly range)': { from: startOfDay(addDays(today, -92)), to: endOfDay(today) },
    '1 year (monthly)': resolveRange({}, 365),
    'next 14 days (future bookings)': { from: startOfDay(today), to: endOfDay(addDays(today, 14)) },
    'across a DST change (Oct–Nov 2026)': { from: startOfDay(new Date(2026, 9, 15)), to: endOfDay(new Date(2026, 10, 15)) },
    'empty range (2020)': { from: startOfDay(new Date(2020, 0, 1)), to: endOfDay(new Date(2020, 0, 31)) },
  };
  const departments = await prisma.department.findMany({ select: { id: true }, take: 3 });
  const doctors = await prisma.doctor.findMany({ select: { id: true }, take: 4 });

  for (const [label, range] of Object.entries(ranges)) {
    await test(`admin analytics, ${label} [${tz}]`, async () => assert.deepStrictEqual(await sql.adminAnalytics(range), await reference.adminAnalytics(range)));
  }
  for (const d of departments) {
    await test(`admin analytics for one department, 1 year [${tz}]`, async () => {
      const range = { ...ranges['1 year (monthly)'], departmentId: d.id };
      assert.deepStrictEqual(await sql.adminAnalytics(range), await reference.adminAnalytics(range));
    });
  }
  for (const doc of doctors) {
    for (const label of ['default 30 days', '1 year (monthly)', 'next 14 days (future bookings)']) {
      await test(`doctor analytics, ${label} [${tz}]`, async () => assert.deepStrictEqual(await sql.doctorAnalytics(doc.id, ranges[label]), await reference.doctorAnalytics(doc.id, ranges[label])));
    }
  }
  await test('the sample really contains data (otherwise the comparison proves nothing)', async () => {
    const a = await sql.adminAnalytics(ranges['1 year (monthly)']);
    assert.ok(a.totals.totalAppointments > 100 && a.totals.emergencyCases > 0 && a.totals.totalReviews > 0 && a.totals.avgEmergencyResponseMinutes !== null);
  });

  await prisma.$disconnect();
  console.log(results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
