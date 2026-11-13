/* eslint-disable no-console */
// Audit log integrity check. Read-only (SELECT only), safe to run on a schedule or by hand.
//   node scripts/verify-audit-chain.js                      verify the whole chain
//   node scripts/verify-audit-chain.js --expect-head=412:ab12…   also check against a head you stored elsewhere
//   node scripts/verify-audit-chain.js --print-head         print "seq:hash" to store off-box (a copy the database owner cannot edit);
//                                                           later passing it back via --expect-head detects removal of the newest rows
// Exit code 0 = intact, 1 = problems found, 2 = could not run.
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const { verifyChain } = require('../src/services/auditIntegrity.service');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
(async () => {
  const db = new PrismaClient();
  try {
    const eh = arg('expect-head');
    const expectHead = eh ? { seq: eh.split(':')[0], hash: eh.split(':')[1] } : undefined;
    const r = await verifyChain(db, { expectHead });
    console.log(`Audit chain: ${r.rows} rows checked${r.baseline ? ` (baseline at seq ${r.baseline.lastSeq}, established ${new Date(r.baseline.establishedAt).toISOString()})` : ' (no baseline recorded)'}`);
    if (process.argv.includes('--print-head') && r.head) console.log(`head ${r.head.seq}:${r.head.hash}`);
    if (r.ok) { console.log('INTACT: no modified, missing, inserted or reordered entries found.'); process.exit(0); }
    console.log(`TAMPERING OR CORRUPTION DETECTED (${r.problems.length}${r.problems.length >= 50 ? '+' : ''} problem(s)):`);
    for (const p of r.problems) console.log(`  seq ${p.seq}  ${p.type}  ${p.detail}  [${p.id || ''}]`);
    process.exit(1);
  } catch (e) { console.error('Could not verify:', e.message); process.exit(2); } finally { await db.$disconnect(); }
})();
