/* eslint-disable no-console */
// P1 item 10 — the API response contract (docs/api-contract.md). Walks EVERY route of the router as each role and anonymously and checks
// the envelope, the error codes, status codes for authentication/authorisation, that downloads stay raw, that nothing sensitive leaks,
// plus the authentication flows, rate limiting, the 500 path and the route inventory document.
//   API_URL=http://localhost:5001 DATABASE_URL=<app role url, *_test database> npm run test:contract
// Run against a freshly seeded TEST database (some probes send empty bodies to mutating routes).
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const express = require('express');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) { console.log('Skipped: set DATABASE_URL to a disposable *_test database'); process.exit(0); }
const BASE = process.env.API_URL || 'http://localhost:5001';
const { inventory, markdown } = require('../scripts/list-api-routes');
const requestId = require('../src/middleware/requestId');
const { errorHandler, notFound } = require('../src/middleware/errorHandler');

const CODES = new Set(['VALIDATION_ERROR', 'BAD_REQUEST', 'MALFORMED_JSON', 'UPLOAD_ERROR', 'REASON_REQUIRED', 'EXPORT_RANGE_TOO_LARGE', 'EXPORT_RANGE_INVALID', 'DATABASE_REQUEST_FAILED',
  'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'PAYLOAD_TOO_LARGE', 'RATE_LIMITED', 'ACCOUNT_LOCKED', 'INTERNAL_ERROR']);
const DOWNLOADS = new Set(['GET /api/files/reports/:id', 'GET /api/files/prescriptions/:id/pdf', 'GET /api/admin/reports/:type']);
const AUTH_TOKEN_ROUTES = new Set(['POST /api/auth/login', 'POST /api/auth/register', 'POST /api/auth/change-password']);
// An empty body on these would change data (replace a schedule, mark everything read, end a session): not probed with the right role
const NO_RIGHT_ROLE_PROBE = new Set(['PUT /api/doctor/availability', 'PATCH /api/notifications/read-all', 'POST /api/auth/logout', 'POST /api/auth/change-password']);
const LEAKS = /passwordHash|password_hash|\$2[aby]\$\d{2}\$|"stack"|node_modules|\/home\/user|PrismaClient|Invalid `prisma|JWT_SECRET|DATABASE_URL|medicore_(app|migrator|seeder):/;
const JWT_LIKE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;

let passed = 0; let failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(`  ✔ ${name}`); } catch (e) { failed += 1; results.push(`  ✘ ${name}\n      ${String(e.stack).split('\n').slice(0, 3).join('\n      ')}`); }
}
const seen = []; // every response body collected for the leak scan: { where, text, authRoute }
async function call(method, p, { token, body, headers = {}, raw, base = BASE, record = true, rawBody } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (rawBody !== undefined) { payload = rawBody; h['Content-Type'] ||= 'application/json'; } else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + p, { method, headers: h, body: payload });
  const ctype = res.headers.get('content-type') || '';
  const buffer = Buffer.from(await res.arrayBuffer());
  const isJson = /json/.test(ctype);
  const text = isJson || /text\//.test(ctype) ? buffer.toString('utf8') : '';
  let json; if (isJson) { try { json = JSON.parse(text); } catch { json = undefined; } }
  if (record && text) seen.push({ where: `${method} ${p}`, text, authRoute: AUTH_TOKEN_ROUTES.has(`${method} ${p.split('?')[0]}`) });
  return { status: res.status, headers: res.headers, ctype, buffer, text, json, isJson };
}
/** Asserts the standard error envelope and returns it */
function assertError(r, status, code, label = '') {
  assert.strictEqual(r.status, status, `${label} status (body: ${r.text.slice(0, 160)})`);
  assert.ok(r.isJson && r.json, `${label} must be JSON`);
  const b = r.json;
  assert.strictEqual(b.success, false, `${label} success flag`);
  assert.strictEqual(typeof b.message, 'string', `${label} message`);
  assert.ok(b.error && typeof b.error === 'object', `${label} error object`);
  assert.ok(CODES.has(b.error.code), `${label} unknown code ${b.error.code}`);
  if (code) assert.strictEqual(b.error.code, code, `${label} code`);
  assert.strictEqual(b.error.status, r.status, `${label} error.status`);
  assert.strictEqual(typeof b.requestId, 'string', `${label} requestId`);
  assert.strictEqual(r.headers.get('x-request-id'), b.requestId, `${label} X-Request-Id header matches`);
  assert.deepStrictEqual(Object.keys(b).filter((k) => !['success', 'message', 'error', 'details', 'requestId'].includes(k)), [], `${label} unexpected keys`);
  if (b.details !== undefined) assert.deepStrictEqual(b.error.details, b.details, `${label} legacy details copy`);
  return b;
}
function assertSuccess(r, label = '') {
  assert.ok(r.status >= 200 && r.status < 300, `${label} status ${r.status}`);
  assert.ok(r.isJson && r.json, `${label} must be JSON`);
  assert.strictEqual(r.json.success, true, `${label} success flag`);
  assert.ok(r.headers.get('x-request-id'), `${label} X-Request-Id`);
  return r.json;
}
async function login(email, password) { const r = await call('POST', '/api/auth/login', { body: { email, password } }); return { token: assertSuccess(r).data.token, user: r.json.data.user }; }
const uuid = () => crypto.randomUUID();
const fill = (p) => p.replace(':type', 'doctors').replace(':kind', 'records').replace(/:[a-zA-Z]+/g, uuid());

(async () => {
  const admin = await login('admin@medicore.com', 'Admin@123');
  const doctor = await login('david.chen@medicore.com', 'Doctor@123');
  const patient = await login('patient@medicore.com', 'Patient@123');
  const tokens = { ADMIN: admin.token, DOCTOR: doctor.token, PATIENT: patient.token };
  const routes = inventory();

  // ═══════════ Every route ═══════════
  await test(`INVENTORY · ${routes.length} routes discovered; every route is documented and docs/api-routes.md is current`, async () => {
    assert.ok(routes.length > 100);
    assert.strictEqual(fs.readFileSync(path.join(__dirname, '../../docs/api-routes.md'), 'utf8'), markdown(routes), 'run: node backend/scripts/list-api-routes.js --write');
    for (const r of routes) assert.ok(r.login || /^\/api\/(auth|public|health)/.test(r.path) || /\/contact/.test(r.path), `${r.method} ${r.path} is open to the public: intended?`);
  });
  await test('EVERY ROUTE · anonymous callers get 401 UNAUTHENTICATED in the standard error shape on every protected route', async () => {
    for (const r of routes.filter((x) => x.login)) {
      const res = await call(r.method, fill(r.path), { body: ['GET', 'DELETE'].includes(r.method) ? undefined : {} });
      assertError(res, 401, 'UNAUTHENTICATED', `${r.method} ${r.path}`);
    }
  });
  await test('EVERY ROUTE · a signed-in user of the wrong role gets 403 FORBIDDEN in the standard error shape', async () => {
    for (const r of routes.filter((x) => x.roles)) {
      const wrong = ['ADMIN', 'DOCTOR', 'PATIENT'].filter((x) => !r.roles.includes(x));
      for (const role of wrong) {
        const res = await call(r.method, fill(r.path), { token: tokens[role], body: ['GET', 'DELETE'].includes(r.method) ? undefined : {} });
        assertError(res, 403, 'FORBIDDEN', `${role} → ${r.method} ${r.path}`);
      }
    }
  });
  await test('EVERY ROUTE · the right role always gets a JSON envelope (success, or a standard error), never a raw/unknown shape; downloads are the only non-JSON', async () => {
    let successes = 0; let errors = 0;
    for (const r of routes.filter((x) => x.login && !NO_RIGHT_ROLE_PROBE.has(`${x.method} ${x.path}`))) {
      const role = r.roles ? r.roles[0] : 'PATIENT';
      const label = `${role} → ${r.method} ${r.path}`;
      const res = await call(r.method, fill(r.path), { token: tokens[role], body: ['GET', 'DELETE'].includes(r.method) ? undefined : {} });
      if (res.status >= 400) { assertError(res, res.status, undefined, label); errors += 1; assert.notStrictEqual(res.status, 500, `${label} must not be a server error`); } else if (res.isJson) {
        const b = assertSuccess(res, label); successes += 1;
        const extra = Object.keys(b).filter((k) => !['success', 'data', 'message', 'meta'].includes(k));
        const legacy = AUTH_TOKEN_ROUTES.has(`${r.method} ${r.path}`) || ['/api/auth/me', '/api/health'].includes(r.path) ? ['token', 'user', 'status', 'time'] : [];
        assert.deepStrictEqual(extra.filter((k) => !legacy.includes(k)), [], `${label} unexpected top-level keys`);
      } else assert.ok(DOWNLOADS.has(`${r.method} ${r.path}`), `${label} returned a non-JSON response but is not a download route`);
    }
    assert.ok(successes > 40 && errors > 30, `exercised both outcomes (${successes} ok, ${errors} errors)`);
  });

  await test('EVERY ROUTE · public routes (no login) return the success envelope with no stray top-level keys; only /api/health keeps the deprecated status/time copies', async () => {
    const open = routes.filter((x) => !x.login && x.method === 'GET');
    assert.ok(open.length >= 5, `found ${open.length} public GET routes`);
    for (const r of open) {
      const label = `public ${r.method} ${r.path}`;
      const res = await call('GET', fill(r.path));
      if (res.status >= 400) { assertError(res, res.status, undefined, label); assert.notStrictEqual(res.status, 500, `${label} must not be a server error`); continue; }
      const b = assertSuccess(res, label);
      const allowed = ['success', 'data', 'message', 'meta', ...(r.path === '/api/health' ? ['status', 'time'] : [])];
      assert.deepStrictEqual(Object.keys(b).filter((k) => !allowed.includes(k)), [], `${label} unexpected top-level keys`);
      assert.ok(b.data !== undefined, `${label} carries its payload in data`);
    }
  });

  await test('EVERY RESPONSE · nothing sensitive in any body collected so far: no hashes, stacks, paths, secrets, DB credentials; tokens only in authentication responses', async () => {
    assert.ok(seen.length > 250, `collected ${seen.length} bodies`);
    for (const s of seen) {
      assert.ok(!LEAKS.test(s.text), `${s.where} leaks: ${(s.text.match(LEAKS) || [])[0]}`);
      if (!s.authRoute) assert.ok(!JWT_LIKE.test(s.text), `${s.where} contains a token`);
    }
  });

  // ═══════════ Authentication flows ═══════════
  await test('AUTH · login: success has data{token,user} plus the deprecated top-level copies; wrong credentials are 401 UNAUTHENTICATED; bad input is a VALIDATION_ERROR with field details', async () => {
    const ok = await call('POST', '/api/auth/login', { body: { email: 'admin@medicore.com', password: 'Admin@123' } });
    const b = assertSuccess(ok);
    assert.ok(b.data.token && b.data.user.role === 'ADMIN'); assert.strictEqual(b.token, b.data.token); assert.deepStrictEqual(b.user, b.data.user);
    assert.ok(!('passwordHash' in b.data.user) && !JSON.stringify(b).includes('passwordHash'));
    const bad = assertError(await call('POST', '/api/auth/login', { body: { email: 'admin@medicore.com', password: 'wrong-password-123!' } }), 401, 'UNAUTHENTICATED');
    assert.ok(!JSON.stringify(bad).includes('wrong-password-123'), 'the submitted password is never echoed');
    const val = assertError(await call('POST', '/api/auth/login', { body: {} }), 400, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(val.error.details) && val.error.details.length > 0 && val.error.details.every((d) => typeof d.field === 'string' && typeof d.message === 'string'));
    assert.match(val.message, /^(email|password): /, 'message names the first field');
    assertError(await call('POST', '/api/auth/login', { body: { email: 'not-an-email', password: 'x' } }), 400, 'VALIDATION_ERROR');
  });
  await test('AUTH · /auth/me and register: data payloads, 409 CONFLICT for a duplicate email, validation errors never echo the password', async () => {
    const me = assertSuccess(await call('GET', '/api/auth/me', { token: admin.token }));
    assert.strictEqual(me.data.user.email, 'admin@medicore.com'); assert.deepStrictEqual(me.user, me.data.user);
    const email = `contract.${Date.now()}@example.com`;
    const reg = await call('POST', '/api/auth/register', { body: { email, password: 'Start@1234', fullName: 'Contract Test' } });
    assert.strictEqual(reg.status, 201); assert.ok(assertSuccess(reg).data.token);
    const dup = assertError(await call('POST', '/api/auth/register', { body: { email, password: 'Start@1234', fullName: 'Contract Test' } }), 409, 'CONFLICT');
    assert.ok(!JSON.stringify(dup).includes('Start@1234'));
    const weak = assertError(await call('POST', '/api/auth/register', { body: { email: `w.${Date.now()}@example.com`, password: 'abcdefgh', fullName: 'X' } }), 400, 'VALIDATION_ERROR');
    assert.ok(!JSON.stringify(weak).includes('abcdefgh'), 'the rejected password is not echoed');
    // logout: success envelope with no payload; anonymous logout is a standard 401
    const out = await call('POST', '/api/auth/logout', { token: admin.token });
    assert.strictEqual(out.status, 200); assert.deepStrictEqual(Object.keys(assertSuccess(out)).sort(), ['success']);
    assertError(await call('POST', '/api/auth/logout'), 401, 'UNAUTHENTICATED');
  });
  await test('AUTH · every kind of bad credential on a protected route is 401 UNAUTHENTICATED (missing, malformed, invalid, expired, wrong secret, unknown user)', async () => {
    const secret = process.env.JWT_SECRET;
    const sub = admin.user.id;
    const cases = {
      'no header': {}, 'not Bearer': { Authorization: 'Basic abc' }, 'empty Bearer': { Authorization: 'Bearer ' }, 'garbage token': { Authorization: 'Bearer abc.def.ghi' },
      'expired': { Authorization: `Bearer ${jwt.sign({ sub }, secret, { expiresIn: -60 })}` },
      'signed with another secret': { Authorization: `Bearer ${jwt.sign({ sub }, 'another-secret-that-is-long-enough-0123456789')}` },
      'unknown user': { Authorization: `Bearer ${jwt.sign({ sub: uuid() }, secret, { expiresIn: 60 })}` },
      'no subject': { Authorization: `Bearer ${jwt.sign({}, secret, { expiresIn: 60 })}` },
    };
    for (const [name, headers] of Object.entries(cases)) assertError(await call('GET', '/api/admin/dashboard', { headers }), 401, 'UNAUTHENTICATED', name);
  });
  await test('AUTH · role boundaries: patient → admin/doctor routes and doctor → admin routes are 403 FORBIDDEN; the same token works on its own routes', async () => {
    assertError(await call('GET', '/api/admin/dashboard', { token: patient.token }), 403, 'FORBIDDEN');
    assertError(await call('GET', '/api/doctor/patients', { token: patient.token }), 403, 'FORBIDDEN');
    assertError(await call('GET', '/api/admin/patients', { token: doctor.token }), 403, 'FORBIDDEN');
    assertSuccess(await call('GET', '/api/patient/dashboard', { token: patient.token }));
    assertSuccess(await call('GET', '/api/doctor/dashboard', { token: doctor.token }));
    assertSuccess(await call('GET', '/api/admin/dashboard', { token: admin.token }));
  });
  await test('AUTH · access-control errors keep their meaning: unrelated doctor 403, missing reason 400 REASON_REQUIRED with details, unknown record 404, double accept 409', async () => {
    const other = (await call('GET', '/api/admin/patients?limit=1', { token: admin.token })).json.data.items[0].id;
    assertError(await call('GET', `/api/doctor/patients/${other}`, { token: doctor.token }), 403, 'FORBIDDEN');
    const reason = assertError(await call('GET', '/api/admin/reports/patients', { token: admin.token }), 400, 'REASON_REQUIRED');
    assert.deepStrictEqual([reason.error.details.minLength, reason.error.details.maxLength], [10, 500]); assert.strictEqual(reason.details.code, 'REASON_REQUIRED');
    assertSuccess(await call('GET', '/api/admin/reports/patients', { token: admin.token, headers: { 'X-Access-Reason': encodeURIComponent('Contract test range') } }), 'with a reason');
  });

  // ═══════════ Transport-level errors ═══════════
  await test('ERRORS · unknown route is 404 NOT_FOUND and does not echo the query string; malformed JSON; payload too large; own request ids', async () => {
    // anonymous callers meet authentication first on any unknown /api path (existing behaviour); signed-in callers get the 404
    assertError(await call('GET', '/api/does-not-exist'), 401, 'UNAUTHENTICATED', 'anonymous');
    const nf = assertError(await call('GET', '/api/does-not-exist?token=SECRETVALUE123&reason=private', { token: admin.token }), 404, 'NOT_FOUND');
    assert.ok(!JSON.stringify(nf).includes('SECRETVALUE123') && !JSON.stringify(nf).includes('private'), 'query string not echoed'); assert.match(nf.message, /\/api\/does-not-exist/);
    assertError(await call('POST', '/api/auth/login', { rawBody: '{"email": "a@b.c", ' }), 400, 'MALFORMED_JSON');
    assertError(await call('POST', '/api/auth/login', { rawBody: JSON.stringify({ email: 'a@b.com', password: 'x'.repeat(1_200_000) }) }), 413, 'PAYLOAD_TOO_LARGE');
    const custom = 'my-request-id-12345';
    const a = await call('GET', '/api/health', { headers: { 'X-Request-Id': custom } }); assert.strictEqual(a.headers.get('x-request-id'), custom);
    const e = await call('GET', '/api/nope', { token: admin.token, headers: { 'X-Request-Id': custom } }); assert.strictEqual(e.json.requestId, custom);
    const evil = await call('GET', '/api/health', { headers: { 'X-Request-Id': 'bad id with spaces <script>' } });
    assert.notStrictEqual(evil.headers.get('x-request-id'), 'bad id with spaces <script>'); assert.match(evil.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  });
  await test('ERRORS · an unexpected failure is 500 INTERNAL_ERROR with a generic message and the request id: no stack, SQL, paths, secrets or request body (real Express pipeline)', async () => {
    const app = express(); app.use(requestId); app.use(express.json());
    app.post('/boom', () => { throw new Error('SELECT * FROM patients WHERE ssn = 123-45-6789 AND password_hash = $2b$12$abcdefghijklmnopqrstuv at /home/user/smart-hospital/backend/src/x.js'); });
    app.get('/boom-prisma', () => { const { Prisma } = require('@prisma/client'); throw new Prisma.PrismaClientKnownRequestError('Invalid `prisma.patient.findMany()` invocation: allergy penicillin', { code: 'P2010', clientVersion: 'x' }); });
    app.use(notFound); app.use(errorHandler);
    const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
    const base = `http://localhost:${server.address().port}`;
    const logged = []; const orig = console.error; console.error = (...a) => logged.push(a.join(' '));
    try {
      const r = await call('POST', '/boom', { base, body: { password: 'Sup3rSecretPw!', diagnosis: 'chest pain' }, record: false });
      const b = assertError(r, 500, 'INTERNAL_ERROR'); assert.strictEqual(b.message, 'Something went wrong. Please try again later.'); assert.deepStrictEqual(Object.keys(b.error), ['code', 'status']);
      for (const bad of ['SELECT', 'ssn', '123-45', '$2b$', '/home/user', 'Sup3rSecretPw', 'chest pain', 'at Object', 'stack']) assert.ok(!r.text.includes(bad), `500 body leaks "${bad}"`);
      const p = assertError(await call('GET', '/boom-prisma', { base, record: false }), 400, 'DATABASE_REQUEST_FAILED');
      assert.ok(!JSON.stringify(p).includes('penicillin') && !JSON.stringify(p).includes('prisma'), 'Prisma text is not forwarded');
      assert.ok(logged.some((l) => l.includes(b.requestId)), 'the server log carries the request id for support');
    } finally { console.error = orig; await new Promise((r) => server.close(r)); }
  });
  await test('RATE LIMITS · limits answer in the standard shape: per-IP 429 RATE_LIMITED and per-account 429 ACCOUNT_LOCKED, both with Retry-After', async () => {
    const port = 5041; const inst = spawn(process.execPath, ['src/server.js', 'contract-ratelimit'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port), AUTH_RATE_LIMIT: '7', LOGIN_MAX_FAILURES: '3', ESCALATION_ENABLED: 'false', NODE_ENV: 'test' }, stdio: 'ignore' });
    try {
      const base = `http://localhost:${port}`;
      for (let i = 0; i < 40; i += 1) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
      const bad = () => call('POST', '/api/auth/login', { base, body: { email: 'patient@medicore.com', password: 'wrong-password-123!' }, record: false });
      for (let i = 0; i < 2; i += 1) assertError(await bad(), 401, 'UNAUTHENTICATED', `attempt ${i + 1}`);
      const locked = await bad(); const lb = assertError(locked, 429, 'ACCOUNT_LOCKED'); // the third failure locks the account
      assert.ok(lb.error.details.retryAfterSeconds > 0 && Number(locked.headers.get('retry-after')) > 0);
      let limited; for (let i = 0; i < 6 && !limited; i += 1) { const r = await bad(); if (r.json?.error?.code === 'RATE_LIMITED') limited = r; }
      assert.ok(limited, 'the per-IP limiter eventually answers'); assertError(limited, 429, 'RATE_LIMITED'); assert.ok(limited.headers.get('retry-after'));
    } finally { inst.kill('SIGKILL'); }
  });

  // ═══════════ Non-JSON responses and other transports ═══════════
  await test('DOWNLOADS · CSV, prescription PDF and report files stay raw (no JSON wrapper); their failures are standard JSON errors', async () => {
    const csv = await call('GET', '/api/admin/reports/doctors?format=csv', { token: admin.token });
    assert.strictEqual(csv.status, 200); assert.match(csv.ctype, /text\/csv/); assert.match(csv.headers.get('content-disposition'), /attachment; filename="doctors-report-/);
    assert.ok(csv.text.split('\n')[0].includes('Doctor') && !csv.text.startsWith('{'), 'CSV text, not JSON');
    const rxList = (await call('GET', '/api/patient/prescriptions', { token: patient.token })).json.data.items;
    assert.ok(rxList.length > 0, 'seed patient has a prescription');
    const pdf = await call('GET', `/api/files/prescriptions/${rxList[0].id}/pdf`, { token: patient.token });
    assert.strictEqual(pdf.status, 200); assert.match(pdf.ctype, /application\/pdf/); assert.strictEqual(pdf.buffer.subarray(0, 4).toString(), '%PDF'); assert.match(pdf.headers.get('content-disposition'), /\.pdf/);
    const form = new FormData(); form.append('title', 'Contract report'); form.append('reportType', 'LAB'); form.append('file', new Blob(['%PDF-1.4\n%contract test\n'], { type: 'application/pdf' }), 'c.pdf');
    const up = await fetch(`${BASE}/api/patient/reports`, { method: 'POST', headers: { Authorization: `Bearer ${patient.token}` }, body: form });
    const upBody = await up.json(); assert.strictEqual(up.status, 201); assert.strictEqual(upBody.success, true);
    const file = await call('GET', `/api/files/reports/${upBody.data.id}`, { token: patient.token });
    assert.strictEqual(file.status, 200); assert.match(file.ctype, /application\/pdf/); assert.strictEqual(file.headers.get('x-content-type-options'), 'nosniff'); assert.ok(file.buffer.toString().startsWith('%PDF-1.4'));
    assertError(await call('GET', `/api/files/prescriptions/${uuid()}/pdf`, { token: patient.token }), 404, 'NOT_FOUND', 'pdf failure');
    assertError(await call('GET', `/api/files/reports/${uuid()}`, { token: patient.token }), 404, 'NOT_FOUND', 'file failure');
    assertError(await call('GET', `/api/files/reports/${upBody.data.id}`, { token: doctor.token }), 403, 'FORBIDDEN', 'unrelated doctor');
    assertError(await call('GET', '/api/admin/reports/doctors?format=csv', { token: patient.token }), 403, 'FORBIDDEN', 'csv by wrong role');
  });
  await test('LISTS · paginated endpoints keep { items, pagination } inside data', async () => {
    for (const [p, t] of [['/api/admin/patients?limit=2', admin], ['/api/admin/appointments?limit=2', admin], ['/api/admin/audit-logs?limit=2', admin], ['/api/doctor/appointments?limit=2', doctor], ['/api/patient/appointments?limit=2', patient],
      ['/api/doctor/patients?limit=2', doctor], ['/api/doctor/reviews?limit=2', doctor], ['/api/patient/prescriptions?limit=2', patient], ['/api/patient/reviews?limit=2', patient], ['/api/complaints?limit=2', patient], ['/api/patient/reports?limit=2', patient]]) {
      const d = assertSuccess(await call('GET', p, { token: t.token }), p).data;
      assert.ok(Array.isArray(d.items) && d.items.length <= 2, p);
      assert.deepStrictEqual(Object.keys(d.pagination).sort(), ['hasNextPage', 'hasPreviousPage', 'limit', 'page', 'total', 'totalItems', 'totalPages'], p);
      assert.strictEqual(d.pagination.total, d.pagination.totalItems, `${p} legacy total`);
    }
  });
  await test('SOCKET.IO · events are unchanged: the payload is the object itself, not an API envelope', async () => {
    const sock = await new Promise((resolve, reject) => { const s = io(BASE, { auth: { token: patient.token }, transports: ['websocket'], reconnection: false, forceNew: true }); s.once('connect', () => resolve(s)); s.once('connect_error', reject); });
    const got = new Promise((resolve) => sock.once('notification:new', resolve));
    assertSuccess(await call('POST', '/api/admin/notifications/broadcast', { token: admin.token, body: { title: 'Contract test', message: 'Socket payload check', audience: 'PATIENT' } }));
    const n = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 5000))]);
    sock.close();
    assert.ok(n, 'notification:new arrived'); assert.ok(n.id && n.title === 'Contract test' && n.message && n.type);
    assert.ok(!('success' in n) && !('data' in n), 'no envelope on socket payloads');
  });

  console.log(results.join('\n'));
  console.log(`\nAPI contract tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Contract suite crashed:', e); process.exit(1); });
