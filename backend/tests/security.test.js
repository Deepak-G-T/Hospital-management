/* eslint-disable no-console */
// P0 security tests: seed guard, token invalidation on password change, socket disconnect on deactivation,
// socket token expiry, trusted audit IP, per-account login throttling.
// Usage (API running against a seeded database):  npm run test:security
//   API_URL=http://localhost:5001  — which API to test (default http://localhost:$PORT)
//   SEED_TEST_DATABASE_URL=…_test  — optional: also runs the seed guard against a disposable *_test database
require('dotenv').config({ quiet: true });
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');
const { seedBlockReason } = require('../prisma/seed-guard');

const BASE = process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`;
const API = `${BASE}/api`;
let passed = 0; let failed = 0; let skipped = 0;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, p, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(API + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(`  ✔ ${name}`); } catch (e) { failed += 1; results.push(`  ✘ ${name}\n      ${e.message}`); }
}
const skip = (name, why) => { skipped += 1; results.push(`  ○ ${name} (skipped: ${why})`); };

const login = (email, password, headers) => req('POST', '/auth/login', { body: { email, password }, headers });
async function register(tag) {
  const email = `p0.${tag}.${Date.now()}@example.com`;
  const r = await req('POST', '/auth/register', { body: { email, password: 'Start@1234', fullName: `P0 ${tag}` } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return { email, password: 'Start@1234', token: r.body.token, id: r.body.user.id };
}
/** Connects a socket; resolves with { socket, error } once connected or refused */
function openSocket(token) {
  return new Promise((resolve) => {
    const socket = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    socket.once('connect', () => resolve({ socket }));
    socket.once('connect_error', (error) => resolve({ socket, error }));
  });
}
const waitDisconnect = (socket, ms) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), ms);
  socket.once('disconnect', (reason) => { clearTimeout(t); resolve(reason); });
});

(async () => {
  const admin = (await login('admin@medicore.com', 'Admin@123')).body;
  assert.ok(admin.token, 'admin login failed — is the API running against a seeded database?');

  // ── 1. Seed guard ──
  await test('seed guard: refuses production unless --force AND ALLOW_PRODUCTION_SEED=true', async () => {
    assert.ok(seedBlockReason({ nodeEnv: 'production', userCount: 0 }));
    assert.ok(seedBlockReason({ nodeEnv: 'production', force: true, userCount: 0 }));
    assert.ok(seedBlockReason({ nodeEnv: 'production', allowProduction: true, userCount: 0 }));
    assert.strictEqual(seedBlockReason({ nodeEnv: 'production', force: true, allowProduction: true, userCount: 5, hasDemoAdmin: true }), null);
  });
  await test('seed guard: refuses a database with users but no demo admin unless --force', async () => {
    assert.ok(seedBlockReason({ nodeEnv: 'development', userCount: 3, hasDemoAdmin: false }));
    assert.strictEqual(seedBlockReason({ nodeEnv: 'development', force: true, userCount: 3, hasDemoAdmin: false }), null);
    assert.strictEqual(seedBlockReason({ nodeEnv: 'development', userCount: 47, hasDemoAdmin: true }), null);
    assert.strictEqual(seedBlockReason({ nodeEnv: undefined, userCount: 0 }), null); // empty database: fine
  });
  const seedDb = process.env.SEED_TEST_DATABASE_URL;
  if (seedDb && /_test(\?|$)/.test(seedDb)) {
    await test('seed guard: `NODE_ENV=production npm run db:seed` exits 1 and deletes nothing', async () => {
      const before = (await req('GET', '/admin/users?limit=1', { token: admin.token })).body.data.pagination.total;
      let code = 0; let out = '';
      try {
        execFileSync(process.execPath, [path.join(__dirname, '../prisma/seed.js')], {
          env: { ...process.env, DATABASE_URL: seedDb, NODE_ENV: 'production' }, stdio: 'pipe', timeout: 60000,
        });
      } catch (e) { code = e.status; out = String(e.stderr); }
      assert.strictEqual(code, 1, 'seed should exit with code 1');
      assert.ok(/Seed refused/.test(out), out);
      const after = (await req('GET', '/admin/users?limit=1', { token: admin.token })).body.data.pagination.total;
      assert.strictEqual(after, before, 'no user rows may be deleted');
    });
  } else skip('seed guard against a real database', 'set SEED_TEST_DATABASE_URL to a disposable *_test database');

  // ── 3. Token invalidation after a password change ──
  await test('password change: earlier tokens rejected (REST + socket), response gains a working token', async () => {
    const u = await register('pwchange');
    const otherDevice = (await login(u.email, u.password)).body.token;
    await sleep(1100); // tokens carry whole-second issue times
    const r = await req('PUT', '/auth/change-password', { token: u.token, body: { currentPassword: u.password, newPassword: 'Changed@5678' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.success, true); assert.ok(r.body.message); // existing contract kept
    assert.ok(r.body.token, 'response should include a renewed token');
    for (const old of [u.token, otherDevice]) {
      const me = await req('GET', '/auth/me', { token: old });
      assert.strictEqual(me.status, 401); assert.ok(/password was changed/i.test(me.body.message));
    }
    assert.strictEqual((await req('GET', '/auth/me', { token: r.body.token })).status, 200);
    const oldSocket = await openSocket(otherDevice);
    assert.ok(oldSocket.error, 'socket with a pre-change token must be refused'); oldSocket.socket.close();
    const newSocket = await openSocket(r.body.token);
    assert.ok(!newSocket.error, 'socket with the renewed token must connect'); newSocket.socket.close();
    assert.strictEqual((await login(u.email, u.password)).status, 401);
    assert.strictEqual((await login(u.email, 'Changed@5678')).status, 200);
  });
  await test('admin password reset: ends the user\'s sessions and live sockets; response unchanged', async () => {
    const u = await register('pwreset');
    const live = await openSocket(u.token); assert.ok(!live.error);
    await sleep(1100);
    const gone = waitDisconnect(live.socket, 4000);
    const r = await req('POST', `/admin/users/${u.id}/reset-password`, { token: admin.token, body: { newPassword: 'Reset@9999' } });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(Object.keys(r.body).sort(), ['message', 'success']);
    assert.strictEqual(await gone, 'io server disconnect');
    assert.strictEqual((await req('GET', '/auth/me', { token: u.token })).status, 401);
    assert.strictEqual((await login(u.email, 'Reset@9999')).status, 200);
  });
  await test('existing sessions are unaffected when the password never changed', async () => {
    const t = (await login('patient@medicore.com', 'Patient@123')).body.token;
    assert.strictEqual((await req('GET', '/auth/me', { token: t })).status, 200);
  });

  // ── 4. Socket disconnect on deactivation ──
  await test('deactivation closes the user\'s live sockets and refuses reconnects', async () => {
    const u = await register('deact');
    const live = await openSocket(u.token); assert.ok(!live.error);
    const gone = waitDisconnect(live.socket, 4000);
    assert.strictEqual((await req('PATCH', `/admin/users/${u.id}/status`, { token: admin.token, body: { isActive: false } })).status, 200);
    assert.strictEqual(await gone, 'io server disconnect');
    const again = await openSocket(u.token);
    assert.ok(again.error, 'reconnect must be refused'); again.socket.close();
    assert.strictEqual((await req('PATCH', `/admin/users/${u.id}/status`, { token: admin.token, body: { isActive: true } })).status, 200);
  });
  await test('other users\' sockets stay connected when someone is deactivated', async () => {
    const keep = await register('keep'); const drop = await register('drop');
    const a = await openSocket(keep.token); const b = await openSocket(drop.token);
    const keepGone = waitDisconnect(a.socket, 1500); const dropGone = waitDisconnect(b.socket, 4000);
    await req('PATCH', `/admin/users/${drop.id}/status`, { token: admin.token, body: { isActive: false } });
    assert.strictEqual(await dropGone, 'io server disconnect');
    assert.strictEqual(await keepGone, null); assert.ok(a.socket.connected);
    a.socket.close();
  });

  // ── 5. Token expiry on long-lived sockets ──
  await test('socket is closed when its token expires; an expired token is refused at the handshake', async () => {
    const u = await register('expiry');
    const short = jwt.sign({ sub: u.id, role: 'PATIENT' }, process.env.JWT_SECRET, { expiresIn: 3, issuer: 'smart-hospital' });
    const live = await openSocket(short); assert.ok(!live.error, 'short-lived token should connect');
    const started = Date.now();
    assert.strictEqual(await waitDisconnect(live.socket, 6000), 'io server disconnect');
    assert.ok(Date.now() - started >= 1500, 'should stay connected until the token expires');
    const expired = await openSocket(short);
    assert.ok(expired.error, 'expired token must be refused'); expired.socket.close();
  });

  // ── 6. Audit IP ──
  await test('audit log stores the proxy-trusted IP, not the client-supplied first X-Forwarded-For value', async () => {
    const u = await register('auditip');
    assert.strictEqual((await login(u.email, u.password, { 'X-Forwarded-For': '203.0.113.66, 198.51.100.23' })).status, 200);
    await sleep(300);
    const logs = await req('GET', '/admin/audit-logs?action=LOGIN&limit=50', { token: admin.token });
    const entry = logs.body.data.items.find((l) => l.action === 'LOGIN' && l.entityId === u.id);
    assert.ok(entry, 'login audit entry not found');
    assert.notStrictEqual(entry.ipAddress, '203.0.113.66', 'spoofed first X-Forwarded-For value must not be recorded');
    assert.strictEqual(entry.ipAddress, '198.51.100.23', 'with trust proxy = 1 the address added by the proxy is used');
  });

  // ── 7. Per-account login throttling ──
  const max = Number(process.env.LOGIN_MAX_FAILURES) || 5;
  await test(`login throttling: ${max} failures lock the account (429 + Retry-After), even with the right password`, async () => {
    const u = await register('lock');
    for (let i = 1; i < max; i += 1) assert.strictEqual((await login(u.email, 'Wrong@0000')).status, 401, `attempt ${i}`);
    const last = await login(u.email, 'Wrong@0000');
    assert.strictEqual(last.status, 429); assert.ok(Number(last.headers.get('retry-after')) > 0);
    const right = await login(u.email, u.password);
    assert.strictEqual(right.status, 429, 'locked account refuses even the right password');
    assert.strictEqual(right.body.success, false); assert.ok(/Too many failed sign-in attempts/.test(right.body.message));
  });
  await test('login throttling: other accounts are unaffected; a success resets the counter', async () => {
    assert.strictEqual((await login('patient@medicore.com', 'Patient@123')).status, 200);
    const u = await register('reset-counter');
    for (let i = 1; i < max; i += 1) await login(u.email, 'Wrong@0000');
    assert.strictEqual((await login(u.email, u.password)).status, 200);
    for (let i = 1; i < max; i += 1) assert.strictEqual((await login(u.email, 'Wrong@0000')).status, 401);
  });
  await test('login throttling: unknown emails behave the same (no account enumeration)', async () => {
    const ghost = `nobody.${Date.now()}@example.com`;
    for (let i = 1; i < max; i += 1) assert.strictEqual((await login(ghost, 'Wrong@0000')).status, 401);
    assert.strictEqual((await login(ghost, 'Wrong@0000')).status, 429);
  });
  await test('login throttling: an admin password reset lifts the lock', async () => {
    const u = await register('unlock');
    for (let i = 0; i < max; i += 1) await login(u.email, 'Wrong@0000');
    assert.strictEqual((await login(u.email, u.password)).status, 429);
    assert.strictEqual((await req('POST', `/admin/users/${u.id}/reset-password`, { token: admin.token, body: { newPassword: 'Unlock@1234' } })).status, 200);
    assert.strictEqual((await login(u.email, 'Unlock@1234')).status, 200);
  });
  await test('registration and normal login still work', async () => {
    const u = await register('regular');
    const r = await login(u.email, u.password);
    assert.strictEqual(r.status, 200); assert.ok(r.body.token); assert.strictEqual(r.body.user.role, 'PATIENT');
  });

  console.log(results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(failed ? 1 : 0);
})();
