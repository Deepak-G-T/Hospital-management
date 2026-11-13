/* eslint-disable no-console */
// P1 item 12 — server-side pagination of every list endpoint (docs/api-contract.md "Pagination").
//   structure and defaults · first / middle / last / past-the-end / empty pages · invalid and oversized page and limit · filters and sort
//   across pages · role access and patient-data privacy on every page · no per-row queries (query count does not grow with the page size)
//   API_URL=http://localhost:5001 DATABASE_URL=<app role url, *_test database> npm run test:pagination   (fresh seed; creates a little test data)
require('dotenv').config({ quiet: true });
const assert = require('assert');

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) { console.log('Skipped: set DATABASE_URL to a disposable *_test database'); process.exit(0); }
const BASE = process.env.API_URL || 'http://localhost:5001';

let passed = 0; let failed = 0; const results = [];
async function test(name, fn) { try { await fn(); passed += 1; results.push(`  ✔ ${name}`); } catch (e) { failed += 1; results.push(`  ✘ ${name}\n      ${String(e.stack).split('\n').slice(0, 4).join('\n      ')}`); } }

async function call(method, p, { token, body, form } = {}) {
  const headers = {}; if (token) headers.Authorization = `Bearer ${token}`;
  let payload; if (form) payload = form; else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  let json; try { json = await res.json(); } catch { json = undefined; }
  return { status: res.status, json, headers: res.headers };
}
const login = async (email, password) => { const r = await call('POST', '/api/auth/login', { body: { email, password } }); return { token: r.json.data.token, user: r.json.data.user }; };
const ok = async (p, token) => { const r = await call('GET', p, { token }); assert.strictEqual(r.status, 200, `${p} → ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`); return r.json.data; };
const idsOf = (d) => d.items.map((x) => x.id);

/** Every page of a list, following hasNextPage; checks the invariants of each page on the way */
async function walk(path, token, limit, { maxPages = 60 } = {}) {
  const sep = path.includes('?') ? '&' : '?'; const all = []; const pages = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const d = await ok(`${path}${sep}page=${page}&limit=${limit}`, token);
    const g = d.pagination;
    assert.strictEqual(g.page, page, `${path} page echo`); assert.strictEqual(g.limit, limit, `${path} limit echo`);
    assert.strictEqual(g.totalPages, Math.ceil(g.totalItems / limit), `${path} totalPages`);
    assert.strictEqual(g.hasPreviousPage, page > 1, `${path} hasPreviousPage on page ${page}`);
    assert.strictEqual(g.hasNextPage, page < g.totalPages, `${path} hasNextPage on page ${page}`);
    assert.strictEqual(d.items.length, page < g.totalPages ? limit : g.totalItems - limit * (g.totalPages - 1), `${path} page ${page} size`);
    all.push(...d.items); pages.push(d);
    if (!g.hasNextPage) return { all, pages, total: g.totalItems };
  }
  return { all, pages, total: pages[0].pagination.totalItems, truncated: true };
}

const ADMIN_LISTS = ['/api/admin/complaints', '/api/admin/patients', '/api/admin/activity?from=2020-01-01', '/api/admin/emergencies', '/api/admin/appointments', '/api/admin/doctors', '/api/admin/audit-logs', '/api/admin/users'];
const DOCTOR_LISTS = ['/api/doctor/appointments?scope=all', '/api/doctor/prescriptions', '/api/doctor/patients', '/api/doctor/reviews', '/api/notifications'];
const PATIENT_LISTS = ['/api/patient/appointments?scope=all', '/api/patient/prescriptions', '/api/patient/reviews', '/api/patient/reports', '/api/complaints'];

(async () => {
  const admin = await login('admin@medicore.com', 'Admin@123');
  const doc = await login('david.chen@medicore.com', 'Doctor@123');
  const pat = await login('patient@medicore.com', 'Patient@123');
  const A = admin.token; const D = doc.token; const P = pat.token;
  const all = [[ADMIN_LISTS, A], [DOCTOR_LISTS, D], [PATIENT_LISTS, P]].flatMap(([list, t]) => list.map((p) => [p, t]));

  // a little data so that the small lists have several pages: complaints and reports of the seeded patient
  for (let i = 1; i <= 5; i += 1) assert.strictEqual((await call('POST', '/api/complaints', { token: P, body: { subject: `Pagination test ${i}`, description: 'A complaint created by the pagination test.', category: 'OTHER' } })).status, 201);
  const pdf = () => { const f = new FormData(); f.append('title', 'Pagination report'); f.append('reportType', 'LAB'); f.append('file', new Blob(['%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'], { type: 'application/pdf' }), 'p.pdf'); return f; };
  const uploaded = [];
  for (let i = 0; i < 4; i += 1) { const r = await call('POST', '/api/patient/reports', { token: P, form: pdf() }); assert.strictEqual(r.status, 201); uploaded.push(r.json.data.id); }

  // ═══════════ Structure and defaults ═══════════
  await test(`STRUCTURE · all ${all.length} paginated lists answer { items, pagination } with the documented fields; defaults are page 1, limit 20`, async () => {
    assert.strictEqual(all.length, 18);
    for (const [p, t] of all) {
      const r = await call('GET', p, { token: t }); assert.strictEqual(r.status, 200, `${p} ${r.status}`);
      assert.strictEqual(r.json.success, true); const d = r.json.data;
      assert.ok(Array.isArray(d.items), `${p} items`);
      const g = d.pagination;
      assert.deepStrictEqual(Object.keys(g).sort(), ['hasNextPage', 'hasPreviousPage', 'limit', 'page', 'total', 'totalItems', 'totalPages'], `${p} pagination fields`);
      assert.strictEqual(g.page, 1, `${p} default page`); assert.strictEqual(g.limit, 20, `${p} default limit`);
      assert.ok(d.items.length <= 20 && Number.isInteger(g.totalItems) && g.totalItems >= d.items.length, `${p} sizes`);
      assert.strictEqual(g.totalPages, Math.ceil(g.totalItems / 20)); assert.strictEqual(g.hasPreviousPage, false); assert.strictEqual(g.hasNextPage, g.totalPages > 1);
      assert.strictEqual(g.total, g.totalItems, `${p} deprecated total mirrors totalItems`);
    }
  });
  await test('STRUCTURE · the exact example of the specification: an empty list is { items: [], pagination: { page 1, limit 20, totalItems 0, totalPages 0, no next, no previous } }', async () => {
    const d = await ok('/api/admin/patients?search=zzzz-no-such-patient', A);
    assert.deepStrictEqual(d, { items: [], pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false, total: 0 } });
  });

  // ═══════════ Validation ═══════════
  await test('VALIDATION · invalid, negative and oversized page/limit are 400 VALIDATION_ERROR naming the field, on every paginated list', async () => {
    const bad = [['page', '0'], ['page', '-1'], ['page', 'abc'], ['page', '1.5'], ['page', '1000001'], ['limit', '0'], ['limit', '-5'], ['limit', '101'], ['limit', 'abc'], ['limit', '1e3']];
    for (const [p, t] of all) {
      for (const [k, v] of bad.slice(0, 7)) { // all lists: the main invalid values
        const r = await call('GET', `${p}${p.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`, { token: t });
        assert.strictEqual(r.status, 400, `${p} ${k}=${v} → ${r.status}`); assert.strictEqual(r.json.error.code, 'VALIDATION_ERROR');
        assert.ok(Array.isArray(r.json.error.details) && r.json.error.details[0].field === k, `${p} ${k}=${v} names the field`);
        assert.ok(!/prisma|stack|select|from /i.test(JSON.stringify(r.json)), 'no internals');
      }
    }
    for (const [k, v] of bad.slice(7)) { const r = await call('GET', `/api/admin/users?${k}=${v}`, { token: A }); assert.strictEqual(r.status, 400, `${k}=${v}`); assert.strictEqual(r.json.error.code, 'VALIDATION_ERROR'); }
    assert.strictEqual((await call('GET', '/api/admin/users?page=', { token: A })).status, 400, 'an empty page value is not silently "1"');
  });
  await test('LIMITS · limit=100 is accepted and echoed, limit=1 gives one item per page, and nothing above 100 is ever returned', async () => {
    const d = await ok('/api/admin/appointments?limit=100', A); assert.strictEqual(d.items.length, 100); assert.strictEqual(d.pagination.limit, 100); assert.ok(d.pagination.totalItems > 100);
    const one = await ok('/api/admin/appointments?limit=1&page=3', A); assert.strictEqual(one.items.length, 1); assert.strictEqual(one.pagination.page, 3); assert.strictEqual(one.pagination.hasPreviousPage, true);
    assert.strictEqual(one.items[0].id, d.items[2].id, 'page 3 of limit 1 is the third item');
    const big = await call('GET', '/api/admin/appointments?limit=100000', { token: A }); assert.strictEqual(big.status, 400);
  });

  // ═══════════ First, middle, last, past the end, empty ═══════════
  await test('PAGES · first, middle and last pages of every list: sizes, numbering, flags, no duplicates, the same order whatever the page size', async () => {
    let multi = 0;
    for (const [p, t] of all) {
      const base = await ok(`${p}${p.includes('?') ? '&' : '?'}limit=1`, t); const total = base.pagination.totalItems;
      if (total >= 3 && total <= 300) {
        const L = Math.max(1, Math.floor(total / 3)); const small = await walk(p, t, L); const big = await walk(p, t, 100);
        assert.ok(small.pages.length >= 3, `${p}: ${small.pages.length} pages`); multi += 1;
        assert.strictEqual(small.all.length, total); assert.strictEqual(new Set(idsOf({ items: small.all })).size, total, `${p} no duplicates or gaps`);
        assert.deepStrictEqual(idsOf({ items: small.all }), idsOf({ items: big.all }), `${p} same order with limit ${L} and 100`);
        const mid = small.pages[1].pagination; assert.ok(mid.hasPreviousPage && mid.hasNextPage, `${p} middle page`);
        assert.ok(!small.pages.at(-1).pagination.hasNextPage && small.pages.at(-1).pagination.hasPreviousPage, `${p} last page`);
      } else if (total > 300) { // large lists: the first three pages agree with one big page
        const slice = (await ok(`${p}${p.includes('?') ? '&' : '?'}limit=100`, t)).items.slice(0, 90);
        const parts = []; for (let pg = 1; pg <= 3; pg += 1) parts.push(...(await ok(`${p}${p.includes('?') ? '&' : '?'}page=${pg}&limit=30`, t)).items);
        assert.deepStrictEqual(idsOf({ items: parts }), idsOf({ items: slice }), `${p} pages of 30 equal the first 90 of one page of 100`); multi += 1;
      }
    }
    assert.ok(multi >= 14, `exercised ${multi} lists across several pages`);
  });
  await test('PAGES · a page past the end is 200 with empty items and the real totals; a new account sees empty lists (totalPages 0)', async () => {
    const d = await ok('/api/admin/users?page=9999&limit=20', A);
    assert.deepStrictEqual(d.items, []); assert.ok(d.pagination.totalItems > 0 && d.pagination.hasNextPage === false && d.pagination.hasPreviousPage === true && d.pagination.page === 9999);
    const email = `pagination.${Date.now()}@example.com`;
    const reg = await call('POST', '/api/auth/register', { body: { email, password: 'Start@1234', fullName: 'Empty Lists' } }); const N = reg.json.data.token;
    for (const p of ['/api/patient/appointments', '/api/patient/prescriptions', '/api/patient/reviews', '/api/patient/reports', '/api/complaints', '/api/notifications']) {
      const g = (await ok(p, N)).pagination; assert.deepStrictEqual([g.totalItems, g.totalPages, g.hasNextPage, g.hasPreviousPage, g.page], [p === '/api/notifications' ? g.totalItems : 0, p === '/api/notifications' ? g.totalPages : 0, false, false, 1], p);
    }
    const e = await ok('/api/complaints?page=2', N); assert.deepStrictEqual(e.items, []); assert.strictEqual(e.pagination.hasPreviousPage, true);
  });

  // ═══════════ Filters and sorting across pages ═══════════
  await test('FILTERS · filters apply to the whole list before it is cut into pages; totals follow the filter', async () => {
    const doctors = await walk('/api/admin/users?role=DOCTOR', A, 5); assert.ok(doctors.pages.length >= 3 && doctors.all.every((u) => u.role === 'DOCTOR'));
    assert.strictEqual(doctors.total, (await ok('/api/admin/users?role=DOCTOR&limit=100', A)).items.length);
    const conf = await walk('/api/admin/appointments?status=CONFIRMED', A, 100, { maxPages: 3 }); assert.ok(conf.all.every((a) => a.status === 'CONFIRMED'));
    const all2 = (await ok('/api/admin/appointments?limit=1', A)).pagination.totalItems; assert.ok(conf.total < all2 && conf.total > 0, 'filtered total is smaller');
    const searched = await ok('/api/admin/patients?search=an&limit=3', A); assert.ok(searched.items.every((x) => /an/i.test(`${x.fullName} ${x.phone || ''} ${x.user?.email || ''}`)));
    const full = await walk('/api/admin/patients?search=an', A, 3); assert.strictEqual(full.total, searched.pagination.totalItems);
    const byName = await ok('/api/admin/users?search=david.chen', A); assert.strictEqual(byName.pagination.totalItems, 1); assert.ok(/david\.chen/.test(byName.items[0].email), 'user search is applied before paging');
    assert.strictEqual((await ok('/api/admin/users?search=zzzz-no-such-user', A)).pagination.totalItems, 0);
    const unread = await walk('/api/notifications?status=unread', D, 2); assert.ok(unread.all.every((n) => n.isRead === false)); assert.strictEqual(unread.total, (await ok('/api/notifications', D)).unread);
    const pend = await walk('/api/patient/appointments?scope=all&status=PENDING', P, 1); assert.ok(pend.all.every((a) => a.status === 'PENDING'));
  });
  await test('SORTING · the existing sort order is kept across pages (newest first; patients A–Z); ties never repeat or skip a row', async () => {
    const users = await walk('/api/admin/users', A, 7); const t = users.all.map((u) => +new Date(u.createdAt));
    assert.ok(t.every((x, i) => i === 0 || t[i - 1] >= x), 'users newest first across page boundaries'); assert.strictEqual(new Set(idsOf({ items: users.all })).size, users.total);
    const mine = await walk('/api/doctor/patients', D, 4); const names = mine.all.map((x) => x.fullName);
    assert.deepStrictEqual(names, (await ok('/api/doctor/patients?limit=100', D)).items.map((x) => x.fullName), 'A–Z order identical on all pages');
    const rx = await walk('/api/patient/prescriptions', P, 6); const rt = rx.all.map((x) => +new Date(x.createdAt)); assert.ok(rt.every((x, i) => i === 0 || rt[i - 1] >= x));
    const aps = await walk('/api/admin/appointments', A, 100, { maxPages: 4 }); assert.strictEqual(new Set(idsOf({ items: aps.all })).size, aps.all.length, 'appointments: no row twice');
    const logs = await walk('/api/admin/audit-logs', A, 100, { maxPages: 4 }); assert.strictEqual(new Set(idsOf({ items: logs.all })).size, logs.all.length, 'audit log: no row twice');
  });
  await test('REVIEWS · the doctor\'s rating summary (average, total, distribution) covers ALL reviews on every page, counted by the database', async () => {
    const p1 = await ok('/api/doctor/reviews?limit=5', D); const p2 = await ok('/api/doctor/reviews?limit=5&page=2', D);
    assert.ok(p1.pagination.totalItems > 10 && p1.items.length === 5);
    for (const k of ['average', 'total', 'distribution']) assert.deepStrictEqual(p1[k], p2[k], `${k} equal on every page`);
    assert.strictEqual(p1.total, p1.pagination.totalItems); assert.strictEqual(p1.distribution.reduce((n, x) => n + x.count, 0), p1.total);
    const every = await walk('/api/doctor/reviews', D, 10); const byRating = [5, 4, 3, 2, 1].map((r) => ({ rating: r, count: every.all.filter((x) => x.rating === r).length }));
    assert.deepStrictEqual(p1.distribution, byRating, 'distribution equals the count over every page');
    assert.ok(every.all.every((x) => x.doctorId === doc.user.profile.id), 'only this doctor\'s reviews');
  });
  await test('SOFT DELETION · deleted and active reports are separate paginated lists that partition the patient\'s reports', async () => {
    assert.strictEqual((await call('DELETE', `/api/patient/reports/${uploaded[0]}`, { token: P })).status, 200);
    const active = await walk('/api/patient/reports', P, 2); const gone = await walk('/api/patient/reports?deleted=true', P, 2);
    assert.strictEqual(active.total, 3); assert.strictEqual(gone.total, 1); assert.ok(active.all.every((r) => !r.deletedAt) && gone.all.every((r) => r.deletedAt));
    assert.ok(!active.all.some((r) => r.id === uploaded[0]) && gone.all[0].id === uploaded[0]);
    assert.strictEqual((await call('POST', `/api/patient/reports/${uploaded[0]}/restore`, { token: P })).status, 200);
    assert.strictEqual((await ok('/api/patient/reports', P)).pagination.totalItems, 4);
  });

  // ═══════════ Access and privacy ═══════════
  await test('ACCESS · every paginated list needs a sign-in (401) and the right role (403)', async () => {
    for (const [p] of all) assert.strictEqual((await call('GET', p)).status, 401, `${p} anonymous`);
    for (const p of ADMIN_LISTS) { assert.strictEqual((await call('GET', p, { token: D })).status, 403, `${p} doctor`); assert.strictEqual((await call('GET', p, { token: P })).status, 403, `${p} patient`); }
    for (const p of DOCTOR_LISTS.filter((x) => !x.startsWith('/api/notifications'))) { assert.strictEqual((await call('GET', p, { token: P })).status, 403, `${p} patient`); assert.strictEqual((await call('GET', p, { token: A })).status, 403, `${p} admin`); }
    for (const p of PATIENT_LISTS.filter((x) => !x.startsWith('/api/complaints'))) { assert.strictEqual((await call('GET', p, { token: D })).status, 403, `${p} doctor`); assert.strictEqual((await call('GET', p, { token: A })).status, 403, `${p} admin`); }
    assert.strictEqual((await call('GET', '/api/complaints', { token: A })).status, 403, 'admins answer complaints through /admin/complaints');
    assert.strictEqual((await call('GET', '/api/doctor/patients?page=0', { token: P })).status, 403, 'role is checked before the query is looked at');
  });
  await test('PRIVACY · the doctor\'s patient list shows only patients with a care relationship, on every page; blood group and allergy counts only for patients under treatment', async () => {
    const mine = await walk('/api/doctor/patients', D, 5); const treating = await walk('/api/doctor/patients?treating=true', D, 5);
    assert.ok(mine.pages.length >= 3);
    const tIds = new Set(treating.all.map((x) => x.id)); const mIds = new Set(mine.all.map((x) => x.id));
    for (const id of tIds) assert.ok(mIds.has(id), 'treating ⊆ all');
    for (const p of mine.all) {
      if (tIds.has(p.id)) assert.ok('bloodGroup' in p && '_count' in p, 'treating patient: blood group and allergy count kept');
      else assert.ok(!('bloodGroup' in p) && !('_count' in p), `${p.fullName}: blood group/allergy count withheld on page ${Math.floor(mine.all.indexOf(p) / 5) + 1}`);
      assert.ok(!('address' in p) && !('emergencyContactName' in p) && !('weightKg' in p), 'no profile detail in the list');
    }
    assert.strictEqual(treating.total, treating.all.length); assert.ok(treating.total < mine.total, 'the treating filter is applied before paging (fewer items, correct total)');
    // the list agrees with the chart policy: listed → chart opens; not listed → 403
    for (const p of mine.all.slice(0, 4)) assert.strictEqual((await call('GET', `/api/doctor/patients/${p.id}`, { token: D })).status, 200, `${p.fullName} chart`);
    const everyone = await walk('/api/admin/patients', A, 100, { maxPages: 2 }); const outsider = everyone.all.find((x) => !mIds.has(x.id));
    assert.ok(outsider); assert.strictEqual((await call('GET', `/api/doctor/patients/${outsider.id}`, { token: D })).status, 403, 'an unlisted patient is not readable either');
  });
  await test('PRIVACY · administrators never receive clinical text or blood group in paged lists; patients see only their own rows', async () => {
    const patients = await walk('/api/admin/patients', A, 10); for (const x of patients.all) for (const k of ['bloodGroup', 'heightCm', 'weightKg', 'allergies', 'medicalRecords']) assert.ok(!(k in x), `admin patient list has no ${k}`);
    const appts = await walk('/api/admin/appointments', A, 100, { maxPages: 3 }); for (const a of appts.all) for (const k of ['diagnosis', 'treatment', 'notes']) assert.ok(!(k in a), `admin appointment list has no ${k}`);
    const em = await walk('/api/admin/emergencies', A, 5, { maxPages: 3 }); for (const e of em.all) assert.ok(!('allergies' in (e.patient || {})) && e.patient?.clinicalWithheld !== undefined, 'admin emergency list: clinical data withheld');
    const rx = await walk('/api/patient/prescriptions', P, 7); assert.ok(rx.all.every((x) => x.patientId === pat.user.profile.id), 'own prescriptions only');
    const ap = await walk('/api/patient/appointments?scope=all', P, 9); assert.ok(ap.all.every((x) => x.patientId === pat.user.profile.id), 'own appointments only');
    const cs = await walk('/api/complaints', P, 2); assert.ok(cs.total >= 5 && cs.all.every((x) => x.complainantUserId === pat.user.id), 'own complaints only');
    const rs = await walk('/api/patient/reports', P, 3); assert.ok(rs.all.every((x) => x.patientId === pat.user.profile.id));
    const notes = await walk('/api/notifications', P, 3); assert.ok(notes.all.every((n) => n.userId === pat.user.id), 'own notifications only');
    assert.ok(!JSON.stringify(rx.pages).includes('passwordHash'), 'no hashes');
  });

  // ═══════════ Efficiency ═══════════
  await test('EFFICIENCY · every list runs a fixed number of database operations whatever the page size (no query per row), and is cut by the database', async () => {
    const prisma = require('../src/config/prisma');
    const doctors = require('../src/services/doctorPortal.service'); const rxs = require('../src/services/prescription.service'); const pPortal = require('../src/services/patientPortal.service');
    const complaints = require('../src/services/complaint.service'); const reports = require('../src/services/medicalReport.service');
    const appts = require('../src/services/appointment.service'); const emergencies = require('../src/services/emergency.service'); const users = require('../src/services/user.service');
    const docId = doc.user.profile.id; const patId = pat.user.profile.id;
    let ops = 0; const log = []; prisma.$use(async (params, next) => { ops += 1; log.push(`${params.model}.${params.action}`); return next(params); });
    const measure = async (fn) => { ops = 0; log.length = 0; const r = await fn(); return { ops, r, log: [...log] }; };
    const cases = {
      'doctor patients': (limit) => doctors.listPatients(docId, { limit }), 'doctor patients (treating)': (limit) => doctors.listPatients(docId, { limit, treating: true }),
      'doctor reviews': (limit) => doctors.listReviews(docId, { limit }), 'patient prescriptions': (limit) => rxs.listForPatient(patId, { limit }), 'patient reviews': (limit) => pPortal.listReviews(patId, { limit }),
      complaints: (limit) => complaints.listForUser(pat.user.id, { limit }), reports: (limit) => reports.listForPatient(patId, false, { limit }),
      'admin appointments': (limit) => appts.listForAdmin({ limit }), 'admin emergencies': (limit) => emergencies.listForAdmin({ limit }), 'admin users': (limit) => users.listUsers({ limit }),
    };
    for (const [name, fn] of Object.entries(cases)) {
      const small = await measure(() => fn(1)); const big = await measure(() => fn(100));
      assert.strictEqual(big.ops, small.ops, `${name}: ${small.ops} operations for 1 row and ${big.ops} for ${big.r.items.length} rows (${big.log.join(', ')})`);
      assert.ok(big.ops <= 6, `${name}: ${big.ops} operations`); assert.ok(big.r.items.length <= 100);
      assert.ok(big.log.some((l) => /\.count$/.test(l)), `${name}: one count`);
      const finds = big.log.filter((l) => /\.findMany$/.test(l)).length;
      if (name.startsWith('doctor patients')) assert.strictEqual(finds, 4, 'treatment ids (3 queries) + the page'); else assert.ok(finds <= 2, `${name}: ${finds} findMany`);
    }
    const rows = (await measure(() => cases['patient prescriptions'](100))).r; assert.ok(rows.items.length > 5, 'the patient has enough prescriptions to make the point');
    await prisma.$disconnect();
  });

  // ═══════════ Lists that stay unpaginated ═══════════
  await test('EXCLUDED · safety-critical boards, small fixed lists and grouped responses are unchanged (no page structure, page/limit ignored)', async () => {
    const plain = [['/api/doctor/emergencies', D], ['/api/patient/emergencies', P], ['/api/patient/medical-records', P], ['/api/patient/allergies', P], ['/api/admin/departments', A], ['/api/doctor/colleagues', D], ['/api/doctor/availability', D], ['/api/public/departments'], ['/api/public/doctors'], ['/api/admin/notifications/broadcasts', A]];
    for (const [p, t] of plain) { const a = await ok(p, t); const b = await ok(`${p}?page=2&limit=1`, t); assert.ok(Array.isArray(a), `${p} is a plain list`); assert.strictEqual(b.length, a.length, `${p} ignores page and limit`); }
    for (const [p, keys] of [['/api/doctor/referrals', ['received', 'sent']], ['/api/doctor/messages', ['inbox', 'sent', 'myDepartments']]]) { const d = await ok(p, D); for (const k of keys) assert.ok(Array.isArray(d[k]), `${p} ${k}`); assert.ok(!d.pagination, `${p} has no pagination`); }
  });

  console.log(results.join('\n'));
  console.log(`\nPagination tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
