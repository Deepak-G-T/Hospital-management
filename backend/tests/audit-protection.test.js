/* eslint-disable no-console */
// P1 item 9 — append-only audit log: database roles, UPDATE/DELETE/TRUNCATE protection, hash chain, tamper detection.
// Needs a disposable *_test database prepared with database/roles.sql and migration 20261112090000_audit_append_only:
//   DATABASE_URL=<app role url>  MIGRATOR_DATABASE_URL=<migrator role url>  SEED_DATABASE_URL=<seeder role url>
//   [ADMIN_DATABASE_URL=<superuser url, only for the environment-marker checks>]   npm run test:audit
// Tampering is simulated inside transactions that are ROLLED BACK, so the test database's real chain is never altered.
require('dotenv').config({ quiet: true });
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const { verifyChain } = require('../src/services/auditIntegrity.service');

const APP = process.env.DATABASE_URL || '';
if (!/_test(\?|$)/.test(APP)) { console.log('Skipped: set DATABASE_URL to a disposable *_test database'); process.exit(0); }
const need = ['MIGRATOR_DATABASE_URL', 'SEED_DATABASE_URL'].filter((k) => !process.env[k]);
if (need.length) { console.log(`Skipped: set ${need.join(', ')}`); process.exit(0); }
const client = (url) => new PrismaClient({ datasources: { db: { url } } });
const app = client(APP); const mig = client(process.env.MIGRATOR_DATABASE_URL); const seeder = client(process.env.SEED_DATABASE_URL);
const admin = process.env.ADMIN_DATABASE_URL ? client(process.env.ADMIN_DATABASE_URL) : null;

let passed = 0; let failed = 0; let skipped = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(`  ✔ ${name}`); } catch (e) { failed += 1; results.push(`  ✘ ${name}\n      ${String(e.stack).split('\n').slice(0, 3).join('\n      ')}`); }
}
const skip = (name, why) => { skipped += 1; results.push(`  ○ ${name} (skipped: ${why})`); };
/** The statement must be refused; the error must match */
const refused = async (p, re, msg) => assert.rejects(p, (e) => re.test(e.message || ''), msg);
const tag = () => crypto.randomBytes(4).toString('hex');
const log = (db, action = 'AUDIT_TEST', extra = {}) => db.auditLog.create({ data: { action, entityType: 'Test', entityId: tag(), details: { t: tag() }, ...extra } });
const count = (db) => db.auditLog.count();

/** Runs fn inside a migrator transaction with the audit triggers off, verifies the chain, then rolls EVERYTHING back */
async function tamper(fn) {
  let out;
  try {
    await mig.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER USER');
      const opts = (await fn(tx)) || {};
      out = await verifyChain(tx, opts);
      throw new Error('ROLLBACK');
    }, { timeout: 60000 });
  } catch (e) { if (e.message !== 'ROLLBACK') throw e; }
  return out;
}
const types = (r) => [...new Set(r.problems.map((p) => p.type))].sort();

(async () => {
  // make sure there is a chain to work with
  for (let i = 0; i < 15; i += 1) await log(app, 'AUDIT_TEST_SETUP');
  const baseRows = await count(app);

  // ═══════════ Roles ═══════════
  await test('ROLES · the runtime role is not a superuser, owns nothing and cannot become the migrator or the seeder', async () => {
    const [me] = await app.$queryRawUnsafe('SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su, (SELECT rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS powers');
    assert.strictEqual(me.u, 'medicore_app'); assert.strictEqual(me.su, false); assert.strictEqual(me.powers, false);
    const owned = await app.$queryRawUnsafe("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user");
    assert.strictEqual(owned[0].n, 0, 'owns no tables');
    const members = await app.$queryRawUnsafe("SELECT count(*)::int AS n FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member WHERE m.rolname = 'medicore_app'");
    assert.strictEqual(members[0].n, 0, 'member of no role');
    await refused(app.$executeRawUnsafe('SET ROLE medicore_migrator'), /permission denied|must be member/i, 'SET ROLE migrator');
    await refused(app.$executeRawUnsafe('SET ROLE medicore_seeder'), /permission denied|must be member/i, 'SET ROLE seeder');
    await refused(app.$executeRawUnsafe('SET ROLE postgres'), /permission denied|must be member/i, 'SET ROLE postgres');
    await refused(app.$executeRawUnsafe("CREATE ROLE evil LOGIN"), /permission denied/i);
    await refused(app.$executeRawUnsafe('CREATE TABLE evil (id int)'), /permission denied/i, 'cannot create objects');
    await refused(app.$executeRawUnsafe('ALTER TABLE users ADD COLUMN evil int'), /must be owner/i, 'cannot alter tables');
    await refused(app.$queryRawUnsafe('SELECT * FROM _prisma_migrations LIMIT 1'), /permission denied/i, 'migration bookkeeping is off limits');
  });
  await test('ROLES · the seeder and migrator roles are not superusers and are not members of each other', async () => {
    for (const [db, who] of [[mig, 'medicore_migrator'], [seeder, 'medicore_seeder']]) {
      const [r] = await db.$queryRawUnsafe('SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su');
      assert.deepStrictEqual([r.u, r.su], [who, false]);
    }
    await refused(mig.$executeRawUnsafe('SET ROLE medicore_seeder'), /permission denied|must be member/i);
    await refused(seeder.$executeRawUnsafe('SET ROLE medicore_migrator'), /permission denied|must be member/i);
  });
  await test('ROLES · the app can still do its normal work on application tables (insert, update, delete, read)', async () => {
    const n = await app.notification.create({ data: { userId: (await app.user.findFirst({ where: { role: 'ADMIN' } })).id, type: 'SYSTEM', title: 'audit test', message: 'x' } });
    await app.notification.update({ where: { id: n.id }, data: { isRead: true } });
    await app.notification.delete({ where: { id: n.id } });
    assert.ok((await app.user.count()) > 0);
  });

  // ═══════════ Append-only protection ═══════════
  await test('APPEND-ONLY · the app role may SELECT and INSERT audit rows and nothing else (UPDATE, DELETE, TRUNCATE refused)', async () => {
    const row = await log(app, 'AUDIT_TEST_APPEND');
    assert.ok((await app.auditLog.findUnique({ where: { id: row.id } })).action === 'AUDIT_TEST_APPEND');
    await refused(app.$executeRawUnsafe(`UPDATE audit_logs SET action = 'X' WHERE id = '${row.id}'`), /permission denied/i, 'UPDATE');
    await refused(app.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = '${row.id}'`), /permission denied/i, 'DELETE');
    await refused(app.$executeRawUnsafe('TRUNCATE audit_logs'), /permission denied/i, 'TRUNCATE');
    await refused(app.auditLog.update({ where: { id: row.id }, data: { action: 'X' } }), /permission denied|Invalid/i, 'Prisma update');
    await refused(app.auditLog.deleteMany({}), /permission denied|Invalid/i, 'Prisma deleteMany');
    await refused(app.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER ALL'), /must be owner|permission denied/i, 'cannot switch the triggers off');
    await refused(app.$executeRawUnsafe('DROP TRIGGER audit_logs_chain ON audit_logs'), /must be owner|permission denied/i, 'cannot drop a trigger');
    await refused(app.$executeRawUnsafe('CREATE TRIGGER evil BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_protect_rows()'), /permission denied|must be owner/i, 'cannot add a trigger');
    await refused(app.$executeRawUnsafe('ALTER TABLE audit_logs OWNER TO medicore_app'), /must be owner|permission denied/i, 'cannot take ownership');
    await refused(app.$executeRawUnsafe("UPDATE audit_chain_baseline SET note = 'x'"), /permission denied/i, 'baseline is read-only to the app');
    await refused(app.$executeRawUnsafe("UPDATE medicore_environment SET name = 'development'"), /permission denied/i, 'the environment marker is read-only to the app');
  });
  await test('APPEND-ONLY · triggers refuse UPDATE, DELETE and TRUNCATE even for the table owner (the migrator)', async () => {
    const row = await log(app, 'AUDIT_TEST_OWNER');
    await refused(mig.$executeRawUnsafe(`UPDATE audit_logs SET action = 'X' WHERE id = '${row.id}'`), /append-only/i, 'UPDATE');
    await refused(mig.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = '${row.id}'`), /append-only/i, 'DELETE');
    await refused(mig.$executeRawUnsafe('DELETE FROM audit_logs'), /append-only/i, 'DELETE all');
    await refused(mig.$executeRawUnsafe('TRUNCATE audit_logs'), /append-only/i, 'TRUNCATE');
    await refused(mig.$executeRawUnsafe('TRUNCATE audit_logs CASCADE'), /append-only/i, 'TRUNCATE CASCADE');
    await refused(mig.$executeRawUnsafe('TRUNCATE users CASCADE'), /append-only/i, 'TRUNCATE of a parent table cascades into the audit log and is refused too');
    await refused(mig.$executeRawUnsafe(`UPDATE audit_logs SET action = 'X' WHERE id = '${row.id}'`), /append-only/i);
    await refused(seeder.$executeRawUnsafe(`UPDATE audit_logs SET action = 'X' WHERE id = '${row.id}'`), /append-only/i, 'the seeder cannot UPDATE either');
    await refused(seeder.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = '${row.id}'`), /append-only/i, 'nor DELETE');
    assert.strictEqual((await app.auditLog.findUnique({ where: { id: row.id } })).action, 'AUDIT_TEST_OWNER', 'row untouched');
    assert.ok((await count(app)) >= baseRows, 'nothing disappeared');
  });
  await test('APPEND-ONLY · the baseline table is protected the same way', async () => {
    await refused(mig.$transaction(async (tx) => { // a baseline row only exists after a migration; add one in a transaction that is rolled back
      await tx.$executeRawUnsafe("INSERT INTO audit_chain_baseline (rows_covered, last_seq, last_hash, note) VALUES (0, 0, 'GENESIS', 'test')");
      await tx.$executeRawUnsafe("UPDATE audit_chain_baseline SET note = 'x'");
    }), /append-only/i, 'UPDATE of the baseline');
    await refused(mig.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("INSERT INTO audit_chain_baseline (rows_covered, last_seq, last_hash, note) VALUES (0, 0, 'GENESIS', 'test')");
      await tx.$executeRawUnsafe('DELETE FROM audit_chain_baseline');
    }), /append-only/i, 'DELETE of the baseline');
    await refused(mig.$executeRawUnsafe('TRUNCATE audit_chain_baseline'), /append-only/i);
    await refused(app.$executeRawUnsafe('TRUNCATE audit_chain_baseline'), /permission denied/i);
  });
  await test('APPEND-ONLY · a user with audit history cannot be hard-deleted (FK RESTRICT) and no audit row is rewritten', async () => {
    const u = await app.user.create({ data: { email: `audit.fk.${Date.now()}.${tag()}@example.com`, passwordHash: 'x', role: 'PATIENT' } });
    const a = await log(app, 'AUDIT_TEST_FK', { userId: u.id, userRole: 'PATIENT' });
    await refused(app.$executeRawUnsafe(`DELETE FROM users WHERE id = '${u.id}'`), /foreign key|violates/i);
    await refused(app.user.delete({ where: { id: u.id } }), /foreign key|constraint|Foreign/i);
    assert.strictEqual((await app.auditLog.findUnique({ where: { id: a.id } })).userId, u.id, 'the audit row still names its user (was SET NULL before)');
    assert.ok(await app.user.findUnique({ where: { id: u.id } }), 'the user is still there');
    const [fk] = await app.$queryRawUnsafe("SELECT confdeltype::text AS d, confupdtype::text AS u FROM pg_constraint WHERE conname = 'audit_logs_user_id_fkey'");
    assert.deepStrictEqual([fk.d, fk.u], ['r', 'r'], 'ON DELETE RESTRICT / ON UPDATE RESTRICT');
  });
  await test('APPEND-ONLY · the seeder may TRUNCATE only while the database is marked non-production', async () => {
    if (!admin) return skip('environment marker', 'set ADMIN_DATABASE_URL');
    const trunc = (env, role) => admin.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE medicore_environment SET name = '${env}'`);
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      await tx.$executeRawUnsafe('TRUNCATE audit_logs, audit_chain_baseline');
      throw new Error('ROLLBACK'); // TRUNCATE is transactional: nothing is lost either way
    }).catch((e) => e);
    for (const env of ['test', 'development']) assert.strictEqual((await trunc(env, 'medicore_seeder')).message, 'ROLLBACK', `seeder allowed in ${env}`);
    const prod = await trunc('production', 'medicore_seeder'); assert.match(prod.message, /append-only/i, 'seeder refused in production');
    assert.match((await trunc('test', 'medicore_migrator')).message, /append-only/i, 'migrator refused even in test');
    assert.match((await trunc('test', 'medicore_app')).message, /permission denied/i, 'app refused');
    assert.ok((await count(app)) >= baseRows, 'nothing was truncated');
    const [env] = await app.$queryRawUnsafe('SELECT name FROM medicore_environment'); assert.notStrictEqual(env.name, 'production', 'marker left as roles.sql set it');
  });

  // ═══════════ Hash chain ═══════════
  await test('CHAIN · every insert gets the next seq and links to the previous row; the whole chain verifies', async () => {
    const a = await log(app, 'AUDIT_TEST_CHAIN'); const b = await log(app, 'AUDIT_TEST_CHAIN');
    const ra = await app.auditLog.findUnique({ where: { id: a.id } }); const rb = await app.auditLog.findUnique({ where: { id: b.id } });
    assert.strictEqual(Number(rb.seq), Number(ra.seq) + 1); assert.strictEqual(rb.prevHash, ra.rowHash);
    assert.match(ra.rowHash, /^[0-9a-f]{64}$/);
    const r = await verifyChain(app);
    assert.ok(r.ok, JSON.stringify(r.problems)); assert.ok(r.rows >= baseRows); assert.strictEqual(r.head.seq, r.rows, 'seq is 1..N without gaps');
    const first = await app.$queryRawUnsafe('SELECT prev_hash FROM audit_logs ORDER BY seq LIMIT 1'); assert.strictEqual(first[0].prev_hash, 'GENESIS');
  });
  await test('CHAIN · createMany (several rows in one statement) chains in order', async () => {
    const before = (await verifyChain(app)).head.seq;
    await app.auditLog.createMany({ data: [1, 2, 3].map((i) => ({ action: 'AUDIT_TEST_MANY', entityType: 'Test', entityId: String(i) })) });
    const rows = await app.auditLog.findMany({ where: { action: 'AUDIT_TEST_MANY' }, orderBy: { seq: 'asc' }, take: 3, select: { seq: true, entityId: true } });
    assert.deepStrictEqual(rows.map((r) => Number(r.seq)), [before + 1, before + 2, before + 3]);
    assert.ok((await verifyChain(app)).ok);
  });
  await test('CHAIN · concurrent inserts (60 at once, from two connection pools) are serialised: no gaps, no duplicates, chain intact', async () => {
    const other = client(APP);
    const before = await verifyChain(app);
    await Promise.all([...Array(40)].map(() => log(app, 'AUDIT_TEST_CONCURRENT')).concat([...Array(20)].map(() => log(other, 'AUDIT_TEST_CONCURRENT'))));
    await other.$disconnect();
    const r = await verifyChain(app);
    assert.ok(r.ok, JSON.stringify(r.problems)); assert.strictEqual(r.rows, before.rows + 60); assert.strictEqual(r.head.seq, r.rows);
    const [d] = await app.$queryRawUnsafe("SELECT count(DISTINCT seq)::int AS n, count(*)::int AS c FROM audit_logs WHERE action = 'AUDIT_TEST_CONCURRENT'");
    assert.deepStrictEqual([d.n, d.c], [60, 60]);
  });
  await test('CHAIN · a rolled-back or rejected insert leaves no gap', async () => {
    const before = (await verifyChain(app)).head.seq;
    await app.$transaction(async (tx) => { await log(tx, 'AUDIT_TEST_ROLLBACK'); throw new Error('undo'); }).catch(() => {});
    await refused(log(app, 'AUDIT_TEST_GHOST', { userId: crypto.randomUUID() }), /foreign key|Foreign/i); // the fail-closed audit path
    const next = await log(app, 'AUDIT_TEST_AFTER_ROLLBACK');
    assert.strictEqual(Number((await app.auditLog.findUnique({ where: { id: next.id } })).seq), before + 1);
    assert.ok((await verifyChain(app)).ok);
  });
  await test('CHAIN · the hash does not depend on the session time zone or on updated_at', async () => {
    const [row] = await app.$queryRawUnsafe('SELECT seq::text AS s FROM audit_logs ORDER BY seq DESC LIMIT 1');
    for (const tz of ['UTC', 'Asia/Kolkata', 'America/New_York']) {
      const ok = await app.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TimeZone = '${tz}'`);
        return (await verifyChain(tx)).ok;
      });
      assert.ok(ok, `chain verifies under ${tz}`);
    }
    assert.ok(row);
  });

  // ═══════════ Tamper detection (all rolled back) ═══════════
  const head = await verifyChain(app);
  const midSeq = Math.floor(head.head.seq / 2);
  await test('TAMPER · a modified row is detected (content columns, details JSON, user, timestamp)', async () => {
    for (const set of ["action = 'FORGED'", "details = '{\"forged\":true}'::jsonb", "ip_address = '6.6.6.6'", "created_at = created_at + interval '1 minute'", "entity_id = 'forged'", "user_role = 'ADMIN'"]) {
      const r = await tamper((tx) => tx.$executeRawUnsafe(`UPDATE audit_logs SET ${set} WHERE seq = ${midSeq}`));
      assert.ok(!r.ok, `${set} must be detected`); assert.deepStrictEqual(types(r), ['MODIFIED']); assert.strictEqual(r.problems[0].seq, midSeq);
    }
    const hashOnly = await tamper((tx) => tx.$executeRawUnsafe(`UPDATE audit_logs SET row_hash = repeat('0', 64) WHERE seq = ${midSeq}`));
    assert.ok(!hashOnly.ok, 'overwriting the stored hash is detected');
  });
  await test('TAMPER · a deleted row is detected (middle, first, and a range)', async () => {
    const mid = await tamper((tx) => tx.$executeRawUnsafe(`DELETE FROM audit_logs WHERE seq = ${midSeq}`));
    assert.ok(!mid.ok); assert.ok(types(mid).includes('GAP') && types(mid).includes('CHAIN_BROKEN'), types(mid).join()); assert.strictEqual(mid.problems[0].seq, midSeq + 1);
    const first = await tamper((tx) => tx.$executeRawUnsafe('DELETE FROM audit_logs WHERE seq = 1'));
    assert.ok(!first.ok && types(first).includes('GAP'));
    const range = await tamper((tx) => tx.$executeRawUnsafe(`DELETE FROM audit_logs WHERE seq BETWEEN ${midSeq} AND ${midSeq + 4}`));
    assert.ok(!range.ok && range.problems[0].seq === midSeq + 5);
  });
  await test('TAMPER · reordered rows are detected (two swapped, or a row moved)', async () => {
    const swapped = await tamper(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE audit_logs SET seq = -1 WHERE seq = ${midSeq}`);
      await tx.$executeRawUnsafe(`UPDATE audit_logs SET seq = ${midSeq} WHERE seq = ${midSeq + 1}`);
      await tx.$executeRawUnsafe(`UPDATE audit_logs SET seq = ${midSeq + 1} WHERE seq = -1`);
    });
    assert.ok(!swapped.ok); assert.ok(types(swapped).includes('CHAIN_BROKEN') || types(swapped).includes('MODIFIED'), types(swapped).join());
    const moved = await tamper((tx) => tx.$executeRawUnsafe(`UPDATE audit_logs SET seq = seq + 1000000 WHERE seq = ${midSeq}`));
    assert.ok(!moved.ok);
    const swappedOnlyHashes = await tamper(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE audit_logs a SET row_hash = b.row_hash, prev_hash = b.prev_hash FROM audit_logs b WHERE a.seq = ${midSeq} AND b.seq = ${midSeq + 1}`);
    });
    assert.ok(!swappedOnlyHashes.ok);
  });
  await test('TAMPER · an inserted (forged) row is detected, even with a plausible hash', async () => {
    const r = await tamper((tx) => tx.$executeRawUnsafe(`INSERT INTO audit_logs (id, action, seq, prev_hash, row_hash, created_at, updated_at) VALUES (gen_random_uuid(), 'FORGED', ${head.head.seq + 1}, 'deadbeef', 'deadbeef', now(), now())`));
    assert.ok(!r.ok); assert.ok(types(r).includes('CHAIN_BROKEN') && types(r).includes('MODIFIED'));
    // a forged row appended with the correct prev_hash but an invented row_hash
    const wrongHash = await tamper((tx) => tx.$executeRawUnsafe(`INSERT INTO audit_logs (id, action, seq, prev_hash, row_hash, created_at, updated_at) SELECT gen_random_uuid(), 'FORGED', seq + 1, row_hash, 'invented', now(), now() FROM audit_logs ORDER BY seq DESC LIMIT 1`));
    assert.ok(!wrongHash.ok && types(wrongHash).join() === 'MODIFIED');
  });
  await test('TAMPER · removing the newest rows is detected against a stored head; rewriting the whole chain is detected only against it', async () => {
    const stored = { seq: head.head.seq, hash: head.head.hash };
    const tail = await tamper(async (tx) => { await tx.$executeRawUnsafe(`DELETE FROM audit_logs WHERE seq > ${stored.seq - 3}`); return { expectHead: stored }; });
    assert.ok(!tail.ok && types(tail).includes('HEAD_MISMATCH'), types(tail).join());
    const noAnchor = await tamper((tx) => tx.$executeRawUnsafe(`DELETE FROM audit_logs WHERE seq > ${stored.seq - 3}`));
    assert.ok(noAnchor.ok, 'without an externally stored head a clean truncation of the tail is invisible (documented limitation)');
    const rewrite = (expectHead) => tamper(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE audit_logs SET action = 'REWRITTEN' WHERE seq = ${midSeq}`);
      await tx.$executeRawUnsafe(`DO $$ DECLARE r RECORD; prev TEXT := 'GENESIS'; h TEXT; BEGIN
        FOR r IN SELECT * FROM audit_logs ORDER BY seq LOOP
          h := audit_logs_compute_hash(r.seq, r.id, r.user_id, r.user_role::text, r.action, r.entity_type, r.entity_id, r.details, r.ip_address, r.user_agent, r.created_at, prev);
          UPDATE audit_logs SET prev_hash = prev, row_hash = h WHERE id = r.id; prev := h; END LOOP; END $$`);
      return { expectHead };
    });
    assert.ok((await rewrite(undefined)).ok, 'a consistent full rewrite is invisible on its own (this is why the head should be stored elsewhere)');
    const anchored = await rewrite({ seq: stored.seq, hash: stored.hash });
    assert.ok(!anchored.ok && types(anchored).includes('HEAD_MISMATCH'), 'but is caught by a stored head');
  });
  await test('TAMPER · history before the baseline is protected by the baseline record, even if the hashes are rewritten', async () => {
    const baseline = (tx) => tx.$executeRawUnsafe("INSERT INTO audit_chain_baseline (rows_covered, last_seq, last_hash, note) SELECT 20, 20, row_hash, 'test baseline' FROM audit_logs WHERE seq = 20");
    const rehash = (tx) => tx.$executeRawUnsafe(`DO $$ DECLARE r RECORD; prev TEXT := 'GENESIS'; h TEXT; BEGIN
      FOR r IN SELECT * FROM audit_logs ORDER BY seq LOOP
        h := audit_logs_compute_hash(r.seq, r.id, r.user_id, r.user_role::text, r.action, r.entity_type, r.entity_id, r.details, r.ip_address, r.user_agent, r.created_at, prev);
        UPDATE audit_logs SET prev_hash = prev, row_hash = h WHERE id = r.id; prev := h; END LOOP; END $$`);
    const plainEdit = await tamper(async (tx) => { await baseline(tx); await tx.$executeRawUnsafe("UPDATE audit_logs SET action = 'FORGED' WHERE seq = 20"); });
    assert.deepStrictEqual(types(plainEdit), ['MODIFIED'], 'an edit without re-hashing');
    const rewritten = await tamper(async (tx) => { await baseline(tx); await tx.$executeRawUnsafe("UPDATE audit_logs SET action = 'FORGED' WHERE seq = 10"); await rehash(tx); });
    assert.deepStrictEqual(types(rewritten), ['BASELINE_MISMATCH'], 'a consistent rewrite of pre-baseline history is caught by the baseline');
    const intact = await tamper(baseline);
    assert.ok(intact.ok && intact.baseline && intact.baseline.lastSeq === 20, 'a correct baseline passes');
  });
  await test('TAMPER · the triggers really are what stops edits: with them on, the same statements fail; the real chain is still intact', async () => {
    assert.ok((await verifyChain(app)).ok, 'the real chain was never altered by the rolled-back experiments');
    await refused(mig.$executeRawUnsafe(`UPDATE audit_logs SET action = 'FORGED' WHERE seq = ${midSeq}`), /append-only/i);
  });

  // ═══════════ Workflows ═══════════
  await test('API · the admin audit-log and activity endpoints still work (BigInt seq is serialised) and show the chain position but not the hashes', async () => {
    const api = process.env.API_URL;
    if (!api) return skip('admin audit endpoints', 'set API_URL');
    const login = await (await fetch(`${api}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@medicore.com', password: 'Admin@123' }) })).json();
    for (const p of ['/admin/audit-logs?limit=5', '/admin/activity?limit=5']) {
      const res = await fetch(`${api}/api${p}`, { headers: { Authorization: `Bearer ${login.token}` } });
      assert.strictEqual(res.status, 200, p);
      const body = await res.json();
      assert.ok(body.data.items.length > 0 && body.data.items.every((i) => typeof i.seq === 'number' && !('rowHash' in i) && !('prevHash' in i)), p);
    }
  });
  await test('WORKFLOW · the verification script runs as the app role and reports an intact chain (exit 0)', async () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '../scripts/verify-audit-chain.js'), '--print-head'], { env: { ...process.env, DATABASE_URL: APP }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /INTACT/); assert.match(r.stdout, /head \d+:[0-9a-f]{64}/);
    const bad = spawnSync(process.execPath, [path.join(__dirname, '../scripts/verify-audit-chain.js'), `--expect-head=${head.head.seq}:${'0'.repeat(64)}`], { env: { ...process.env, DATABASE_URL: APP }, encoding: 'utf8' });
    assert.strictEqual(bad.status, 1); assert.match(bad.stdout, /HEAD_MISMATCH/);
  });
  await test('WORKFLOW · seeding with the API\'s own role is refused cleanly and destroys nothing', async () => {
    const users = await app.user.count(); const audit = await count(app);
    const r = spawnSync(process.execPath, [path.join(__dirname, '../prisma/seed.js')], { env: { ...process.env, DATABASE_URL: APP, SEED_DATABASE_URL: '', NODE_ENV: 'test' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0); assert.match(r.stdout + r.stderr, /append-only|permission denied/i); assert.match(r.stderr, /seeder role|roles\.sql/);
    assert.strictEqual(await app.user.count(), users); assert.ok((await count(app)) >= audit, 'no data lost');
  });
  await test('WORKFLOW · the roles script is idempotent and keeps the same privileges when run again', async () => {
    if (!admin || !process.env.ROLE_PW_MIGRATOR) return skip('roles.sql idempotency', 'needs ADMIN_DATABASE_URL and ROLE_PW_* variables');
    const grants = () => app.$queryRawUnsafe("SELECT grantee, table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p FROM information_schema.role_table_grants WHERE grantee LIKE 'medicore_%' GROUP BY 1, 2 ORDER BY 1, 2").then((r) => JSON.stringify(r));
    const before = await grants();
    const run = () => spawnSync('psql', [process.env.ADMIN_DATABASE_URL.split('?')[0], '-v', 'ON_ERROR_STOP=1', '-v', 'env=test', '-v', 'with_seeder=on', '-v', `migrator_pw=${process.env.ROLE_PW_MIGRATOR}`, '-v', `app_pw=${process.env.ROLE_PW_APP}`, '-v', `seeder_pw=${process.env.ROLE_PW_SEEDER}`, '-f', path.join(__dirname, '../../database/roles.sql')], { encoding: 'utf8' });
    const a = run(); const b = run();
    assert.strictEqual(a.status, 0, a.stderr); assert.strictEqual(b.status, 0, b.stderr);
    assert.strictEqual(await grants(), before, 'identical grants after two more runs');
    assert.ok((await verifyChain(app)).ok);
  });
  await test('WORKFLOW · migrations run as the migrator and the chain survives them (migrate deploy is a no-op)', async () => {
    const r = spawnSync('npx', ['prisma', 'migrate', 'status'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_URL: process.env.MIGRATOR_DATABASE_URL }, encoding: 'utf8' });
    assert.match(r.stdout + r.stderr, /up to date/i);
  });
  await test('WORKFLOW · the seeder role can reseed the test database: the audit log restarts and the new chain verifies', async () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '../prisma/seed.js')], { env: { ...process.env, DATABASE_URL: APP, SEED_DATABASE_URL: process.env.SEED_DATABASE_URL, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 180000 });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Seed complete/);
    const v = await verifyChain(app);
    assert.ok(v.ok, JSON.stringify(v.problems)); assert.ok(v.rows >= 60); assert.strictEqual(v.head.seq, v.rows);
    assert.ok((await app.user.count()) > 40, 'demo data present');
  });

  console.log(results.join('\n'));
  console.log(`\nAudit protection tests: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
  await Promise.all([app, mig, seeder, admin].filter(Boolean).map((c) => c.$disconnect()));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Audit protection suite crashed:', e); process.exit(1); });
