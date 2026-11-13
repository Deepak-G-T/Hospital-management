/* eslint-disable no-console */
// P1 item 11 — the OpenAPI 3.1 document (docs/openapi.json) and the Swagger UI endpoints.
//  • static: the file is current, valid OpenAPI 3.1, documents every route with the right roles/security, examples pass the real validators,
//    downloads are documented separately, the error codes match docs/api-contract.md
//  • live: the documented examples are SENT to the API and every real response (success and error) is validated against its documented schema
//  • docs endpoints: /api/openapi.json, /api/docs, only whitelisted assets, and OFF in production unless API_DOCS=true
//   API_URL=http://localhost:5001 DATABASE_URL=<app role url, *_test database> npm run test:openapi    (fresh seed; it creates and removes test data)
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { Validator } = require('@seriousme/openapi-schema-validator');

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) { console.log('Skipped: set DATABASE_URL to a disposable *_test database'); process.exit(0); }
const BASE = process.env.API_URL || 'http://localhost:5001';
const { inventory } = require('../scripts/list-api-routes');
const { render, FILE } = require('../scripts/build-openapi');
const { routes: meta, ID } = require('../src/openapi/routes');
const { z } = require('zod');

const SPEC_TEXT = fs.readFileSync(FILE, 'utf8');
const spec = JSON.parse(SPEC_TEXT);
const OPS = Object.entries(spec.paths).flatMap(([p, o]) => Object.entries(o).map(([m, op]) => ({ method: m.toUpperCase(), path: `/api${p.replace(/\{(\w+)\}/g, ':$1')}`, op })));
const opOf = (key) => OPS.find((o) => `${o.method} ${o.path}` === key).op;

let passed = 0; let failed = 0; const results = [];
async function test(name, fn) { try { await fn(); passed += 1; results.push(`  ✔ ${name}`); } catch (e) { failed += 1; results.push(`  ✘ ${name}\n      ${String(e.stack).split('\n').slice(0, 4).join('\n      ')}`); } }

// ── JSON Schema validation of live data against the document's components ──
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv); ajv.addFormat('binary', true);
ajv.addSchema(JSON.parse(JSON.stringify({ components: spec.components }).replace(/#\/components\//g, 'oas#/components/')), 'oas');
const validators = new Map();
function validatorFor(dataName) {
  if (!validators.has(dataName)) {
    const list = dataName.endsWith('[]'); const n = list ? dataName.slice(0, -2) : dataName;
    validators.set(dataName, ajv.compile(list ? { type: 'array', items: { $ref: `oas#/components/schemas/${n}` } } : { $ref: `oas#/components/schemas/${n}` }));
  }
  return validators.get(dataName);
}
const errs = (v) => JSON.stringify((v.errors || []).slice(0, 4).map((e) => `${e.instancePath || '/'} ${e.message}`));
const conforms = (schemaRef, value, label) => {
  const v = ajv.compile({ $ref: `oas#/components/schemas/${schemaRef}` });
  assert.ok(v(value), `${label} does not match ${schemaRef}: ${errs(v)}\n${JSON.stringify(value).slice(0, 300)}`);
};

// ── HTTP helpers ──
async function call(method, p, { token, body, headers = {}, form, base = BASE } = {}) {
  const h = { ...headers }; if (token) h.Authorization = `Bearer ${token}`;
  let payload; if (form) payload = form; else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + p, { method, headers: h, body: payload });
  const ctype = res.headers.get('content-type') || '';
  const buffer = Buffer.from(await res.arrayBuffer());
  let json; if (/json/.test(ctype)) { try { json = JSON.parse(buffer.toString('utf8')); } catch { json = undefined; } }
  return { status: res.status, headers: res.headers, ctype, buffer, json, text: /text|json|javascript/.test(ctype) ? buffer.toString('utf8') : '' };
}
const REAL = {}; // placeholder example ids -> ids of the test database
const subst = (v) => JSON.parse(Object.entries(REAL).reduce((s, [k, id]) => s.split(ID[k]).join(id), JSON.stringify(v)));
const REASON = { 'X-Access-Reason': 'API documentation conformance test on test data' };
const exercised = new Set(); // operations a live call reached
let seq = 0; const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

/** Calls a documented operation with its documented example body (ids swapped for real ones) and checks the response against the document */
async function doc(key, { vars = {}, token, body, query = '', headers = {}, status, form } = {}) {
  const [method, rawPath] = key.split(' ');
  const [, dataName, opt = {}] = meta[key];
  exercised.add(key);
  const p = rawPath.replace(/:(\w+)/g, (_, k) => { assert.ok(vars[k], `${key}: no value for :${k}`); return vars[k]; }) + query;
  const b = form ? undefined : body !== undefined ? body : opt.ex ? subst(opt.ex) : undefined;
  const res = await call(method, p, { token, body: b, headers: { ...(opt.reason ? REASON : {}), ...headers }, form });
  const expected = status || opt.s || 200;
  assert.strictEqual(res.status, expected, `${key} → ${res.status} (expected ${expected}) ${res.text.slice(0, 200)}`);
  assert.ok(res.headers.get('x-request-id'), `${key} X-Request-Id`);
  if (/json/.test(res.ctype)) {
    assert.strictEqual(res.json.success, true, `${key} success flag`);
    if (dataName) { assert.ok(res.json.data !== undefined, `${key} has data`); const v = validatorFor(dataName); assert.ok(v(res.json.data), `${key} data does not match ${dataName}: ${errs(v)}\n${JSON.stringify(res.json.data).slice(0, 400)}`); } else assert.strictEqual(res.json.data, undefined, `${key} documented as having no data`);
    if (opt.msg) assert.strictEqual(typeof res.json.message, 'string', `${key} message`);
    assert.ok(opOf(key).responses[String(expected)], `${key} documents ${expected}`);
  }
  return res;
}
const login = async (email, password) => { const r = await call('POST', '/api/auth/login', { body: { email, password } }); return { token: r.json.data.token, user: r.json.data.user }; };

(async () => {
  const routes = inventory();

  // ═══════════ Static checks on the document ═══════════
  await test('FILE · docs/openapi.json is current (run: npm --prefix backend run openapi)', async () => {
    assert.strictEqual(SPEC_TEXT, render(routes));
  });
  await test('VALID · the document is valid OpenAPI 3.1 and every $ref resolves', async () => {
    const v = new Validator(); const r = await v.validate(spec);
    assert.ok(r.valid, String(JSON.stringify(r.errors)).slice(0, 500)); assert.strictEqual(spec.openapi, '3.1.0'); assert.strictEqual(v.version, '3.1');
    const refs = [...SPEC_TEXT.matchAll(/"\$ref": "#\/([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length > 500);
    for (const r2 of new Set(refs)) { let n = spec; for (const part of r2.split('/')) { n = n?.[part]; } assert.ok(n, `unresolved $ref #/${r2}`); }
  });
  await test(`COVERAGE · all ${routes.length} routes are documented, nothing more, with unique operation ids`, async () => {
    assert.strictEqual(routes.length, 112);
    assert.strictEqual(OPS.length, routes.length);
    const doced = new Set(OPS.map((o) => `${o.method} ${o.path}`));
    for (const r of routes) assert.ok(doced.has(`${r.method} ${r.path}`), `${r.method} ${r.path} undocumented`);
    assert.strictEqual(new Set(OPS.map((o) => o.op.operationId)).size, OPS.length, 'operationIds are unique');
    for (const o of OPS) { assert.ok(o.op.summary && o.op.tags?.length, `${o.method} ${o.path} summary/tag`); assert.ok(spec.tags.some((t) => t.name === o.op.tags[0]), `${o.op.tags[0]} is a declared tag`); }
    assert.deepStrictEqual(Object.keys(meta).sort(), routes.map((r) => `${r.method} ${r.path}`).sort());
  });
  await test('AUTH · bearer JWT scheme; protected operations require it, public ones do not; x-roles equal the real route guards', async () => {
    assert.deepStrictEqual(Object.keys(spec.components.securitySchemes), ['bearerAuth']);
    assert.deepStrictEqual({ ...spec.components.securitySchemes.bearerAuth, description: undefined }, { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: undefined });
    for (const r of routes) {
      const op = opOf(`${r.method} ${r.path}`); const label = `${r.method} ${r.path}`;
      if (r.login) { assert.deepStrictEqual(op.security, [{ bearerAuth: [] }], `${label} security`); assert.ok(op.responses['401'], `${label} 401`); } else assert.deepStrictEqual(op.security, [], `${label} is public`);
      assert.deepStrictEqual(op['x-roles'], r.roles || (r.login ? ['ADMIN', 'DOCTOR', 'PATIENT'] : []), `${label} roles`);
      if (r.roles) assert.ok(op.responses['403'], `${label} 403`);
      assert.ok(op.responses['429'] && op.responses['500'], `${label} 429/500`);
      assert.ok(op.parameters.some((p) => p.$ref === '#/components/parameters/XRequestId'), `${label} request id header`);
    }
    for (const k of ['POST /api/auth/login', 'POST /api/auth/register', 'GET /api/health', 'GET /api/public/stats', 'POST /api/public/contact']) assert.deepStrictEqual(opOf(k).security, [], k);
  });
  await test('REQUESTS · generated from the real zod validators: required fields and constraints are present; every example passes the real validator', async () => {
    for (const r of routes.filter((x) => x.schemas.body)) {
      const label = `${r.method} ${r.path}`; const op = opOf(label); const ex = meta[label][2]?.ex;
      assert.ok(op.requestBody, `${label} requestBody`);
      const media = op.requestBody.content['application/json'] || op.requestBody.content['multipart/form-data'];
      assert.ok(media.schema.properties && Object.keys(media.schema.properties).length, `${label} body properties`);
      if (!/PUT \/api\/doctor\/availability|PATCH \/api\/admin\/emergencies/.test(label) || ex) assert.ok(ex, `${label} needs an example`);
      if (ex) { const p = r.schemas.body.safeParse(ex); assert.ok(p.success, `${label} example rejected by the validator: ${String(JSON.stringify(p.error?.issues)).slice(0, 300)}`); assert.deepStrictEqual(media.example, ex); }
    }
    const login = opOf('POST /api/auth/login').requestBody.content['application/json'].schema;
    assert.deepStrictEqual(login.required.sort(), ['email', 'password']); assert.strictEqual(login.properties.password.maxLength, 128);
    const reg = opOf('POST /api/auth/register').requestBody.content['application/json'].schema;
    assert.strictEqual(reg.properties.password.minLength, 8); assert.ok(reg.properties.gender.anyOf.some((x) => x.enum?.includes('FEMALE')));
    for (const r of routes.filter((x) => x.schemas.params)) { const params = opOf(`${r.method} ${r.path}`).parameters.filter((p) => p.in === 'path'); assert.ok(params.length && params.every((p) => p.required), `${r.method} ${r.path} path parameters`); }
    // multipart uploads
    for (const k of ['POST /api/patient/reports', 'POST /api/doctor/patients/:id/reports']) { const s = opOf(k).requestBody.content['multipart/form-data'].schema; assert.ok(s.required.includes('file') && s.properties.file.format === 'binary', k); }
  });
  await test('EXAMPLES · every response example in the document matches its schema', async () => {
    let n = 0;
    for (const o of OPS) for (const [code, resp] of Object.entries(o.op.responses)) for (const [type, media] of Object.entries(resp.content || {})) {
      if (!/json/.test(type) || media.example === undefined) continue;
      const schema = media.schema; const v = ajv.compile(JSON.parse(JSON.stringify(schema).replace(/#\/components\//g, 'oas#/components/'))); n += 1;
      assert.ok(v(media.example), `${o.method} ${o.path} ${code} example: ${errs(v)}`);
    }
    for (const [name, resp] of Object.entries(spec.components.responses)) for (const [ex, e] of Object.entries(resp.content['application/json'].examples)) { conforms('ErrorResponse', e.value, `${name}/${ex}`); n += 1; }
    assert.ok(n >= 12, `validated ${n} examples`);
  });
  await test('DOWNLOADS · CSV, PDF and file downloads are documented as non-JSON responses; every other success is a JSON envelope', async () => {
    const dl = { 'GET /api/files/reports/:id': ['application/pdf', 'image/png', 'text/plain'], 'GET /api/files/prescriptions/:id/pdf': ['application/pdf'], 'GET /api/admin/reports/:type': ['application/json', 'text/csv'] };
    for (const [k, types] of Object.entries(dl)) { const ok = Object.entries(opOf(k).responses).find(([c]) => c === '200')[1]; for (const t of types) assert.ok(ok.content[t], `${k} documents ${t}`); assert.ok(ok.headers['Content-Disposition'], `${k} Content-Disposition`); }
    assert.ok(!opOf('GET /api/files/prescriptions/:id/pdf').responses['200'].content['application/json'], 'PDF is not documented as JSON');
    for (const o of OPS) { if (dl[`${o.method} ${o.path}`]) continue; const ok = Object.entries(o.op.responses).find(([c]) => /^2/.test(c)); assert.deepStrictEqual(Object.keys(ok[1].content), ['application/json'], `${o.method} ${o.path}`); }
  });
  await test('ERRORS · ErrorResponse and the code list match docs/api-contract.md and the error handler; every status the API uses is documented', async () => {
    const md = fs.readFileSync(path.join(__dirname, '../../docs/api-contract.md'), 'utf8');
    const table = [...md.matchAll(/^\| `([A-Z_]+)`(?: \/ `([A-Z_]+)`)? \| \d+ \|/gm)].flatMap((m) => [m[1], m[2]]).filter(Boolean).sort();
    assert.deepStrictEqual([...spec.components.schemas.ErrorCode.enum].sort(), table, 'ErrorCode enum = docs/api-contract.md table');
    const e = spec.components.schemas.ErrorResponse; assert.deepStrictEqual(e.required.sort(), ['error', 'message', 'requestId', 'success']);
    assert.deepStrictEqual(Object.keys(spec.components.responses).sort(), ['Conflict', 'Forbidden', 'NotFound', 'RateLimited', 'ServerError', 'Unauthenticated', 'ValidationError']);
    assert.ok(opOf('POST /api/auth/login').responses['400'] && opOf('POST /api/auth/login').responses['401'] && opOf('POST /api/auth/register').responses['409']);
    assert.ok(spec.components.responses.RateLimited.content['application/json'].examples.accountLocked.value.error.details.retryAfterSeconds);
    assert.ok(spec.components.responses.RateLimited.headers['Retry-After']);
    assert.ok(JSON.stringify(spec.components.parameters.AccessReason).includes('minLength'), 'access reason header documented');
    for (const k of ['GET /api/admin/patients/:id', 'GET /api/admin/emergencies/:id', 'GET /api/admin/reports/:type', 'POST /api/admin/restore/:kind/:id', 'GET /api/files/reports/:id', 'GET /api/files/prescriptions/:id/pdf']) assert.ok(opOf(k).parameters.some((p) => p.$ref === '#/components/parameters/AccessReason') && opOf(k)['x-access-reason'], `${k} access reason`);
  });
  await test('SAFETY · the document contains no secrets, real tokens, e-mails of seeded users, stack traces or database URLs', async () => {
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(SPEC_TEXT), 'no JWT');
    assert.ok(!/postgres(ql)?:\/\/|JWT_SECRET|passwordHash|\$2[aby]\$|node_modules|\/home\/user|medicore\.com|medicore_(app|migrator|seeder)/.test(SPEC_TEXT), 'no internal details');
  });

  // ═══════════ Live conformance: documented examples are sent, real responses are validated ═══════════
  const admin = await login('admin@medicore.com', 'Admin@123');
  const dr = await login('david.chen@medicore.com', 'Doctor@123');
  const pt = await login('patient@medicore.com', 'Patient@123');
  const A = admin.token; const D = dr.token; const P = pt.token;
  const list = async (p, t, h = {}) => { const r = await call('GET', p, { token: t, headers: h }); return Array.isArray(r.json.data) ? r.json.data : r.json.data.items; };
  const doctors = await list('/api/admin/doctors', A);
  REAL.doctor = doctors.find((d) => d.user.email === 'david.chen@medicore.com').id; REAL.doctor2 = doctors.find((d) => d.id !== REAL.doctor).id;
  REAL.department = (await list('/api/admin/departments', A))[0].id;
  REAL.patient = pt.user.profile.id;
  const myAppts = await list('/api/patient/appointments?limit=100', P);
  const done = myAppts.find((a) => a.status === 'COMPLETED' && !a.review);
  assert.ok(done, 'the seeded patient has a completed, unreviewed appointment');
  REAL.appointment = done.id;
  const treating = doctors.find((d) => d.id === done.doctorId); // the doctor of that past appointment: consultation notes, prescription
  const T = (await login(treating.user.email, 'Doctor@123')).token;
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  await test('LIVE public · every public route returns what the document says', async () => {
    await doc('GET /api/health'); await doc('GET /api/public/stats');
    const depts = (await doc('GET /api/public/departments')).json.data; assert.ok(depts.length);
    await doc('GET /api/public/departments', { query: '?search=cardio' });
    await doc('GET /api/public/departments/:id', { vars: { id: depts[0].id } });
    await doc('GET /api/public/doctors'); await doc('GET /api/public/doctors/:id', { vars: { id: REAL.doctor } });
    await doc('GET /api/public/doctors/:id/slots', { vars: { id: REAL.doctor }, query: `?date=${day(8)}` });
    await doc('POST /api/public/contact');
  });
  await test('LIVE auth · register, login, me, change-password, logout match the documented shapes (incl. deprecated top-level copies)', async () => {
    const email = `openapi.${uniq()}@example.com`;
    const reg = await doc('POST /api/auth/register', { body: { ...subst(meta['POST /api/auth/register'][2].ex), email } });
    assert.ok(reg.json.token && reg.json.user, 'deprecated top-level copies still present'); assert.deepStrictEqual(reg.json.token, reg.json.data.token);
    const lg = await doc('POST /api/auth/login', { body: { email, password: 'Start@1234' } });
    await doc('GET /api/auth/me', { token: lg.json.data.token });
    const cp = await doc('PUT /api/auth/change-password', { token: lg.json.data.token, body: { currentPassword: 'Start@1234', newPassword: 'Changed@5678' } });
    await doc('POST /api/auth/logout', { token: cp.json.data.token });
  });
  const RX_ID = (await list('/api/patient/prescriptions', P))[0].id;
  await test('LIVE errors · real error responses match ErrorResponse and the codes the document names', async () => {
    const cases = [
      [await call('POST', '/api/auth/login', { body: { email: 'not-an-email' } }), 400, 'VALIDATION_ERROR'],
      [await call('POST', '/api/auth/login', { body: { email: 'admin@medicore.com', password: 'wrong-password-1' } }), 401, 'UNAUTHENTICATED'],
      [await call('GET', '/api/admin/users'), 401, 'UNAUTHENTICATED'],
      [await call('GET', '/api/admin/users', { token: P }), 403, 'FORBIDDEN'],
      [await call('GET', `/api/files/prescriptions/${RX_ID}/pdf`, { token: A }), 400, 'REASON_REQUIRED'],
      [await call('GET', '/api/public/departments/00000000-0000-4000-8000-000000000000'), 404, 'NOT_FOUND'],
      [await call('GET', '/api/admin/patients/not-a-uuid', { token: A, headers: REASON }), 400, 'VALIDATION_ERROR'],
      [await call('POST', '/api/public/contact', { body: {} }), 400, 'VALIDATION_ERROR'],
    ];
    for (const [res, status, code] of cases) {
      assert.strictEqual(res.status, status, `${res.text.slice(0, 120)}`); assert.strictEqual(res.json.error.code, code);
      conforms('ErrorResponse', res.json, code);
      assert.strictEqual(res.headers.get('x-request-id'), res.json.requestId);
    }
    const dup = await call('POST', '/api/auth/register', { body: { ...subst(meta['POST /api/auth/register'][2].ex), email: 'patient@medicore.com' } });
    assert.strictEqual(dup.status, 409); conforms('ErrorResponse', dup.json, 'duplicate');
    const reasonErr = (await call('GET', `/api/files/prescriptions/${RX_ID}/pdf`, { token: A })).json;
    const withheld = (await call('GET', `/api/admin/patients/${REAL.patient}`, { token: A })).json.data;
    assert.strictEqual(withheld.clinicalWithheld, true, 'patient detail without a reason is withheld, as documented');
    const doced = spec.components.responses.ValidationError.content['application/json'].examples.reasonRequired.value;
    assert.deepStrictEqual(Object.keys(reasonErr.error.details).sort(), Object.keys(doced.error.details).sort(), 'REASON_REQUIRED details documented as they are');
  });
  await test('LIVE admin reads · every admin GET (with the access reason where required) matches its schema; CSV and 366-day rules as documented', async () => {
    const t = A; const reads = ['dashboard', 'activity', 'audit-logs', 'users', 'doctors', 'patients', 'departments', 'appointments', 'emergencies', 'escalation-config', 'complaints', 'notifications/broadcasts'];
    for (const x of reads) await doc(`GET /api/admin/${x}`, { token: t });
    await doc('GET /api/admin/doctors/:id', { token: t, vars: { id: REAL.doctor } });
    await doc('GET /api/admin/patients/:id', { token: t, vars: { id: REAL.patient } });
    const em = (await list('/api/admin/emergencies', t))[0]; await doc('GET /api/admin/emergencies/:id', { token: t, vars: { id: em.id } });
    await doc('GET /api/admin/reports/:type', { token: t, vars: { type: 'doctors' } });
    const csv = await doc('GET /api/admin/reports/:type', { token: t, vars: { type: 'departments' }, query: '?format=csv' });
    assert.ok(/text\/csv/.test(csv.ctype) && /attachment/.test(csv.headers.get('content-disposition')), 'CSV download as documented');
    const wide = await call('GET', '/api/admin/reports/patients?from=2020-01-01&to=2026-01-01', { token: t, headers: REASON });
    assert.strictEqual(wide.json.error.code, 'EXPORT_RANGE_TOO_LARGE'); conforms('ErrorResponse', wide.json, 'range');
    assert.ok(spec.components.schemas.ErrorCode.enum.includes('EXPORT_RANGE_TOO_LARGE'));
  });

  let newDoctor; let newPatient; let newDept; let apptId; let apptId2; let apptId3;
  await test('LIVE admin writes · create/update/delete/restore of departments, doctors, patients, users, broadcasts', async () => {
    const id = uniq();
    newDept = (await doc('POST /api/admin/departments', { token: A, body: { ...subst(meta['POST /api/admin/departments'][2].ex), name: `Allergy ${id}` } })).json.data;
    await doc('PUT /api/admin/departments/:id', { token: A, vars: { id: newDept.id }, body: { name: `Allergy ${id} B`, isActive: true } });
    newDoctor = (await doc('POST /api/admin/doctors', { token: A, body: { ...subst(meta['POST /api/admin/doctors'][2].ex), email: `doc.${id}@example.com`, licenseNumber: `LIC-${id}`, departmentIds: [newDept.id], primaryDepartmentId: newDept.id } })).json.data;
    await doc('PUT /api/admin/doctors/:id', { token: A, vars: { id: newDoctor.id } });
    await doc('PUT /api/admin/doctors/:id/departments', { token: A, vars: { id: newDoctor.id }, body: { departmentIds: [newDept.id, REAL.department], primaryDepartmentId: newDept.id } });
    newPatient = (await doc('POST /api/admin/patients', { token: A, body: { ...subst(meta['POST /api/admin/patients'][2].ex), email: `pat.${id}@example.com` } })).json.data;
    await doc('PUT /api/admin/patients/:id', { token: A, vars: { id: newPatient.id } });
    await doc('PATCH /api/admin/users/:id/status', { token: A, vars: { id: newPatient.userId }, body: { isActive: true } });
    await doc('POST /api/admin/users/:id/reset-password', { token: A, vars: { id: newPatient.userId } });
    await doc('DELETE /api/admin/doctors/:id', { token: A, vars: { id: newDoctor.id } });
    await doc('POST /api/admin/doctors/:id/restore', { token: A, vars: { id: newDoctor.id } });
    await doc('DELETE /api/admin/departments/:id', { token: A, vars: { id: newDept.id } });
    await doc('POST /api/admin/departments/:id/restore', { token: A, vars: { id: newDept.id } });
    const b = (await doc('POST /api/admin/notifications/broadcast', { token: A })).json.data;
    const bl = await doc('GET /api/admin/notifications/broadcasts', { token: A }); assert.ok(bl.json.data.some((x) => x.id === b.broadcastId));
    await doc('DELETE /api/admin/notifications/broadcasts/:id', { token: A, vars: { id: b.broadcastId } });
  });

  await test('LIVE patient · profile, appointments (book, reschedule, cancel), history, allergies, reports, emergencies, reviews, soft deletion and restore', async () => {
    for (const x of ['dashboard', 'profile', 'prescriptions', 'emergencies', 'reviews']) await doc(`GET /api/patient/${x}`, { token: P });
    await doc('PUT /api/patient/profile', { token: P });
    // free slots of the test doctor
    const free = async (n) => (await call('GET', `/api/public/doctors/${REAL.doctor}/slots?date=${day(n)}`)).json.data.slots.filter((s) => s.available);
    let n = 9; let s1 = []; while (!s1.length && n < 30) { s1 = await free(n); n += 1; }
    assert.ok(s1.length > 3, 'free slots found');
    apptId = (await doc('POST /api/patient/appointments', { token: P, body: { ...subst(meta['POST /api/patient/appointments'][2].ex), startAt: s1[0].startAt } })).json.data.id;
    apptId2 = (await doc('POST /api/patient/appointments', { token: P, body: { doctorId: REAL.doctor, startAt: s1[1].startAt, reason: 'Follow-up', type: 'FOLLOW_UP' } })).json.data.id;
    apptId3 = (await doc('POST /api/patient/appointments', { token: P, body: { doctorId: REAL.doctor, startAt: s1[3].startAt, reason: 'Admin will confirm' } })).json.data.id;
    await doc('PATCH /api/patient/appointments/:id/reschedule', { token: P, vars: { id: apptId2 }, body: { startAt: s1[2].startAt } });
    await doc('PATCH /api/patient/appointments/:id/cancel', { token: P, vars: { id: apptId2 } });
    await doc('GET /api/patient/appointments', { token: P, query: '?status=PENDING' });
    const rec = (await doc('POST /api/patient/medical-records', { token: P })).json.data;
    await doc('PUT /api/patient/medical-records/:id', { token: P, vars: { id: rec.id } });
    await doc('DELETE /api/patient/medical-records/:id', { token: P, vars: { id: rec.id } });
    assert.ok((await list('/api/patient/medical-records?deleted=true', P)).some((x) => x.id === rec.id), 'deleted record listed with ?deleted=true');
    await doc('GET /api/patient/medical-records', { token: P, query: '?deleted=true' });
    await doc('POST /api/patient/medical-records/:id/restore', { token: P, vars: { id: rec.id } });
    await doc('DELETE /api/patient/medical-records/:id', { token: P, vars: { id: rec.id } });
    const adminRestore = await doc('POST /api/admin/restore/:kind/:id', { token: A, vars: { kind: 'records', id: rec.id } });
    assert.ok(adminRestore.json.message);
    await doc('GET /api/patient/medical-records', { token: P });
    const al = (await doc('POST /api/patient/allergies', { token: P })).json.data;
    await doc('PUT /api/patient/allergies/:id', { token: P, vars: { id: al.id } });
    await doc('DELETE /api/patient/allergies/:id', { token: P, vars: { id: al.id } });
    await doc('POST /api/patient/allergies/:id/restore', { token: P, vars: { id: al.id } });
    await doc('GET /api/patient/allergies', { token: P });
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
    const form = new FormData(); Object.entries(meta['POST /api/patient/reports'][2].ex).forEach(([k, v]) => form.append(k, v)); form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'xray.pdf');
    const rep = (await doc('POST /api/patient/reports', { token: P, form })).json.data;
    assert.ok(/^[0-9a-f-]{36}\.pdf$/.test(rep.storedName) && !('filePath' in rep) && !/[\\/]/.test(rep.storedName), 'storedName is an opaque name, never a path');
    await doc('GET /api/patient/reports', { token: P });
    exercised.add('GET /api/files/reports/:id');
    const dl = await call('GET', `/api/files/reports/${rep.id}`, { token: P });
    assert.strictEqual(dl.status, 200); assert.ok(/pdf/.test(dl.ctype) && /attachment/.test(dl.headers.get('content-disposition')) && dl.headers.get('x-content-type-options') === 'nosniff', 'report download headers as documented');
    assert.ok(!/^\{/.test(dl.buffer.toString('utf8').slice(0, 1)), 'a download is not a JSON envelope');
    await doc('DELETE /api/patient/reports/:id', { token: P, vars: { id: rep.id } });
    await doc('POST /api/patient/reports/:id/restore', { token: P, vars: { id: rep.id } });
    const upErr = await call('POST', '/api/patient/reports', { token: P, form: (() => { const f = new FormData(); f.append('title', 'x'); f.append('reportType', 'LAB'); f.append('file', new Blob(['MZ evil'], { type: 'application/x-msdownload' }), 'a.exe'); return f; })() });
    assert.strictEqual(upErr.status, 400); conforms('ErrorResponse', upErr.json, 'upload error');
    const em = (await doc('POST /api/patient/emergencies', { token: P, body: { priority: 'CRITICAL', symptoms: 'OpenAPI test: chest pain', locationConsent: false } })).json.data;
    assert.strictEqual((await call('POST', '/api/patient/emergencies', { token: P, body: { priority: 'LOW', symptoms: 'second active request' } })).json.error.code, 'CONFLICT');
    await doc('GET /api/patient/emergencies', { token: P });
    // the doctor handles it (CRITICAL alerts every doctor, so this does not depend on who is on shift)
    await doc('GET /api/doctor/emergencies', { token: D });
    await doc('POST /api/doctor/emergencies/:id/seen', { token: D, vars: { id: em.id } });
    await doc('POST /api/doctor/emergencies/:id/acknowledge', { token: D, vars: { id: em.id } });
    await doc('POST /api/doctor/emergencies/:id/accept', { token: D, vars: { id: em.id } });
    await doc('POST /api/doctor/emergencies/:id/resolve', { token: D, vars: { id: em.id } });
    const em2 = (await doc('POST /api/patient/emergencies', { token: P, body: { priority: 'CRITICAL', symptoms: 'OpenAPI test: second request' } })).json.data;
    await doc('POST /api/doctor/emergencies/:id/escalate', { token: D, vars: { id: em2.id } });
    await doc('POST /api/patient/emergencies/:id/cancel', { token: P, vars: { id: em2.id } });
    const em3 = (await doc('POST /api/patient/emergencies', { token: P, body: { priority: 'CRITICAL', symptoms: 'OpenAPI test: third request' } })).json.data;
    await doc('POST /api/admin/emergencies/:id/acknowledge', { token: A, vars: { id: em3.id } });
    await doc('PATCH /api/admin/emergencies/:id', { token: A, vars: { id: em3.id } });
    await doc('POST /api/admin/emergencies/:id/resolve', { token: A, vars: { id: em3.id } });
  });

  await test('LIVE doctor · portal reads and writes (profile, availability, consultation, records, reports, prescriptions, referrals, messages)', async () => {
    for (const x of ['dashboard', 'profile', 'availability', 'colleagues', 'referrals', 'messages', 'reviews', 'prescriptions', 'appointments']) await doc(`GET /api/doctor/${x}`, { token: D });
    await doc('GET /api/doctor/patients', { token: D, query: '?treating=true' });
    const original = (await call('GET', '/api/doctor/availability', { token: D })).json.data.map(({ dayOfWeek, startTime, endTime }) => ({ dayOfWeek, startTime, endTime }));
    await doc('PUT /api/doctor/profile', { token: D });
    await doc('PUT /api/doctor/availability', { token: D });
    await doc('PUT /api/doctor/availability', { token: D, body: { slots: original } });
    // the appointment booked by the patient above
    await doc('PATCH /api/doctor/appointments/:id/status', { token: D, vars: { id: apptId }, body: { status: 'CONFIRMED' } });
    await doc('PATCH /api/admin/appointments/:id/status', { token: A, vars: { id: apptId3 } });
    await doc('GET /api/admin/appointments', { token: A, query: '?status=CONFIRMED' });
    // a past, completed appointment of this patient with this doctor (a future one cannot be completed yet)
    await doc('PATCH /api/doctor/appointments/:id/consultation', { token: T, vars: { id: REAL.appointment } });
    await doc('GET /api/patient/appointments', { token: P, query: '?status=COMPLETED' });
    await doc('POST /api/doctor/prescriptions', { token: T });
    const rxs = await list('/api/patient/prescriptions', P); const rx = rxs.find((x) => x.appointmentId === REAL.appointment && x.advice === 'Rest and fluids');
    assert.ok(rx, 'the new prescription is listed for the patient');
    exercised.add('GET /api/files/prescriptions/:id/pdf');
    const pdf = await call('GET', `/api/files/prescriptions/${rx.id}/pdf`, { token: P });
    assert.strictEqual(pdf.status, 200); assert.ok(/application\/pdf/.test(pdf.ctype) && pdf.buffer.slice(0, 4).toString() === '%PDF', 'prescription PDF as documented');
    await doc('POST /api/patient/reviews', { token: P });
    const treat = (await list('/api/doctor/patients?treating=true', D)).find((x) => x.id === REAL.patient) || (await list('/api/doctor/patients', D))[0];
    await doc('GET /api/doctor/patients/:id', { token: D, vars: { id: treat.id } });
    const own = REAL.patient;
    await doc('POST /api/doctor/patients/:id/records', { token: D, vars: { id: own } });
    const pdfBuf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
    const form = new FormData(); Object.entries(meta['POST /api/doctor/patients/:id/reports'][2].ex).forEach(([k, v]) => form.append(k, v)); form.append('file', new Blob([pdfBuf], { type: 'application/pdf' }), 'lab.pdf');
    await doc('POST /api/doctor/patients/:id/reports', { token: D, vars: { id: own }, form });
    const ref = (await doc('POST /api/doctor/referrals', { token: D })).json.data;
    const toDoc = doctors.find((d) => d.id === REAL.doctor2); const toLogin = await call('POST', '/api/auth/login', { body: { email: toDoc.user.email, password: 'Doctor@123' } });
    assert.ok(toLogin.json?.data?.token, 'second doctor can sign in');
    await doc('PATCH /api/doctor/referrals/:id', { token: toLogin.json.data.token, vars: { id: ref.id } });
    await doc('POST /api/doctor/messages', { token: D, body: subst(meta['POST /api/doctor/messages'][2].ex) });
  });

  await test('LIVE complaints and notifications', async () => {
    const c = (await doc('POST /api/complaints', { token: P })).json.data;
    await doc('GET /api/complaints', { token: P });
    await doc('GET /api/admin/complaints', { token: A, query: '?status=OPEN' });
    await doc('PATCH /api/admin/complaints/:id/respond', { token: A, vars: { id: c.id } });
    const notes = (await doc('GET /api/notifications', { token: P, query: '?limit=5' })).json.data.items; assert.ok(notes.length);
    await doc('PATCH /api/notifications/:id/read', { token: P, vars: { id: notes[0].id } });
    await doc('PATCH /api/notifications/read-all', { token: P });
    await doc('DELETE /api/notifications/:id', { token: P, vars: { id: notes[0].id } });
  });

  await test('LIVE coverage · every documented operation was called live at least once and matched its documented response', async () => {
    exercised.add('POST /api/auth/logout');
    const missing = OPS.map((o) => `${o.method} ${o.path}`).filter((k) => !exercised.has(k));
    assert.deepStrictEqual(missing, [], `never reached by a live call: ${missing.join(', ')}`);
  });

  // ═══════════ Swagger UI and the document endpoints ═══════════
  await test('SERVER · /api/openapi.json serves the document byte for byte; /api/docs serves Swagger UI with its three files only', async () => {
    const j = await call('GET', '/api/openapi.json'); assert.strictEqual(j.status, 200); assert.ok(/application\/json/.test(j.ctype)); assert.strictEqual(j.text, SPEC_TEXT);
    const ui = await call('GET', '/api/docs'); assert.strictEqual(ui.status, 200); assert.ok(/text\/html/.test(ui.ctype));
    assert.ok(ui.text.includes('/api/docs/assets/swagger-ui-bundle.js') && ui.text.includes('/api/docs/init.js') && !/<script>[^<]/.test(ui.text), 'no inline script (works under a strict CSP)');
    assert.strictEqual((await call('GET', '/api/docs/')).status, 200);
    assert.ok(/'self'/.test(ui.headers.get('content-security-policy')) && ui.headers.get('x-content-type-options') === 'nosniff' && ui.headers.get('x-request-id'));
    const init = await call('GET', '/api/docs/init.js'); assert.ok(init.text.includes('/api/openapi.json') && /persistAuthorization: false/.test(init.text));
    for (const f of ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js']) { const a = await call('GET', `/api/docs/assets/${f}`); assert.strictEqual(a.status, 200, f); assert.ok(a.buffer.length > 1000); }
    for (const f of ['package.json', '../package.json', '%2e%2e/package.json', 'swagger-ui-bundle.js.map', 'absolute-path.js']) { const a = await call('GET', `/api/docs/assets/${f}`); assert.strictEqual(a.status, 404, f); assert.strictEqual(a.json.error.code, 'NOT_FOUND'); conforms('ErrorResponse', a.json, f); }
    assert.strictEqual((await call('POST', '/api/openapi.json', { body: {} })).status, 404, 'POST is not served');
    assert.ok(!/token|password|secret/i.test(init.text.replace(/persistAuthorization/, '')), 'no secrets in the UI bootstrap');
  });
  await test('PRODUCTION · docs are OFF in production (standard 404) unless API_DOCS=true; the API itself is unaffected', async () => {
    const run = async (port, extra) => {
      const inst = spawn(process.execPath, ['src/server.js', 'openapi-prod-check'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port), NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), ...extra }, stdio: 'ignore' });
      const base = `http://localhost:${port}`;
      try {
        for (let i = 0; i < 60; i += 1) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
        return { base, health: (await fetch(`${base}/api/health`)).status, spec: await call('GET', '/api/openapi.json', { base }), ui: await call('GET', '/api/docs', { base }), asset: await call('GET', '/api/docs/assets/swagger-ui.css', { base }) };
      } finally { inst.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 300)); }
    };
    const off = await run(5042, { API_DOCS: '' });
    assert.strictEqual(off.health, 200);
    for (const r of [off.spec, off.ui, off.asset]) { assert.strictEqual(r.status, 404); assert.strictEqual(r.json.error.code, 'NOT_FOUND'); assert.ok(!/swagger|openapi/i.test(r.text.replace('"NOT_FOUND"', ''))); }
    const on = await run(5043, { API_DOCS: 'true' });
    assert.strictEqual(on.spec.status, 200); assert.strictEqual(on.ui.status, 200); assert.strictEqual(on.asset.status, 200);
  });

  console.log(results.join('\n'));
  console.log(`\nOpenAPI tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
