/* eslint-disable no-console */
// One-time cleanup: removes symptom excerpts and escalation reasons from notification messages that were stored before the
// privacy change (new notifications are already generic). Only the `message` text changes. id, user, type, title, link,
// is_read, read_at, broadcast_id, created_at and updated_at are left exactly as they are (plain SQL UPDATE, so Prisma's
// updated_at is not touched), and the script proves it before committing.
//
//   node scripts/scrub-notification-symptoms.js                       DRY RUN (default): counts and samples, changes nothing
//   node scripts/scrub-notification-symptoms.js --execute --backup=<pg_dump file>
//                                                                     rewrites the messages in one transaction
//   add --allow-production when NODE_ENV=production
//
// --execute refuses to run unless a non-empty backup file made in the last 2 hours is named. It is idempotent: rows that are
// already generic are skipped, so running it twice changes nothing the second time.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => (args.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const execute = flag('execute');

// [what the old text looked like, rewrite]. Titles identify the notification kind; the message is rewritten only when it
// still has the old shape.
const RULES = [
  { name: 'new emergency (admins)', title: /^New \w+ emergency$/, message: /^(?!New emergency request requires attention).+/s, to: () => 'New emergency request requires attention.' },
  { name: 'emergency alert (doctors)', title: /^\w+ emergency alert$/, message: /^(?!Emergency alert requires attention|.*requires attention).+/s, to: () => 'Emergency alert requires attention — open the emergency board.' },
  { name: 'automatic escalation level', title: /emergency — escalation level \d$/, message: /^(Not yet accepted after the [\d.]+-minute target\. Alert widened to [^:]+): .+/s, to: (m) => `${m[1]}. Open the emergency board.` },
  { name: 'emergency assigned to doctor', title: /^Emergency assigned to you$/, message: /^Admin assigned you an? (\w+) emergency: .+/s, to: (m) => `Admin assigned you a ${m[1]} emergency. Open the emergency board.` },
  { name: 'doctor escalation (admins)', title: /^Emergency escalated$/, message: /^(Dr\. .+? escalated an emergency to \w+): .+/s, to: (m) => `${m[1]}. The reason is on the emergency timeline.` },
];

function rewrite(title, message) {
  for (const r of RULES) {
    if (!r.title.test(title)) continue;
    const m = message.match(r.message);
    if (!m) continue;
    const next = r.to(m);
    if (next !== message) return { rule: r.name, next };
  }
  return null;
}

(async () => {
  const url = process.env.DATABASE_URL || '';
  const dbName = (url.match(/\/([^/?]+)(\?|$)/) || [])[1] || '(unknown)';
  if (process.env.NODE_ENV === 'production' && !flag('allow-production')) { console.error('Refusing: NODE_ENV=production needs --allow-production'); process.exit(1); }
  if (execute) {
    const file = opt('backup');
    const ok = file && fs.existsSync(file) && fs.statSync(file).size > 0 && Date.now() - fs.statSync(file).mtimeMs < 2 * 3600 * 1000;
    if (!ok) { console.error('Refusing to execute: pass --backup=<file> naming a non-empty database backup made in the last 2 hours (pg_dump).'); process.exit(1); }
    console.log(`Backup confirmed: ${file} (${fs.statSync(file).size} bytes)`);
  }
  const db = new PrismaClient();
  console.log(`${execute ? 'EXECUTE' : 'DRY RUN'} on database "${dbName}"`);

  const rows = await db.notification.findMany({ where: { type: 'EMERGENCY' }, select: { id: true, title: true, message: true } });
  const changes = rows.map((r) => ({ ...r, hit: rewrite(r.title, r.message) })).filter((r) => r.hit);
  const byRule = {};
  for (const c of changes) (byRule[c.hit.rule] ||= []).push(c);
  console.log(`\nEMERGENCY notifications: ${rows.length}   to rewrite: ${changes.length}   already generic/untouched: ${rows.length - changes.length}`);
  for (const [rule, list] of Object.entries(byRule)) {
    console.log(`\n  ${rule}: ${list.length}`);
    for (const c of list.slice(0, 2)) console.log(`    before: ${c.message.slice(0, 70)}${c.message.length > 70 ? '…' : ''}\n    after : ${c.hit.next}`);
  }
  console.log('\nColumns preserved: id, user_id, type, title, link, is_read, read_at, broadcast_id, created_at, updated_at');
  if (!execute) { console.log('\nNothing was changed. Re-run with --execute --backup=<file> after approval.'); await db.$disconnect(); return; }
  if (!changes.length) { console.log('\nNothing to do.'); await db.$disconnect(); return; }

  const ids = changes.map((c) => c.id);
  const fingerprint = (tx) => tx.$queryRaw`SELECT md5(string_agg(concat_ws('|', id, user_id, type, title, coalesce(link,''), is_read, coalesce(read_at::text,''), coalesce(broadcast_id::text,''), created_at, updated_at), ';' ORDER BY id)) AS h, count(*)::int AS n FROM notifications WHERE id = ANY(${ids}::uuid[])`;
  await db.$transaction(async (tx) => {
    const [before] = await fingerprint(tx);
    let done = 0;
    for (const c of changes) {
      // the old message is part of the condition: a row someone else changed in the meantime is skipped, not overwritten
      done += await tx.$executeRaw`UPDATE notifications SET message = ${c.hit.next} WHERE id = ${c.id}::uuid AND message = ${c.message}`;
    }
    const [after] = await fingerprint(tx);
    if (done !== changes.length) throw new Error(`expected ${changes.length} rows, updated ${done} — rolled back`);
    if (before.h !== after.h || before.n !== after.n) throw new Error('a column other than message changed — rolled back');
    console.log(`\nUpdated ${done} rows; ids, recipients, titles, read state and timestamps verified identical.`);
  }, { timeout: 120000 });
  await db.$disconnect();
})().catch((e) => { console.error('FAILED, nothing was changed:', e.message); process.exit(1); });
