// Verifies the audit log's hash chain (see migration 20261112090000_audit_append_only).
// Every row stores seq (1,2,3… with no gaps), prev_hash (the previous row's row_hash, 'GENESIS' for the first) and row_hash
// (SHA-256 over the row's content + prev_hash, computed by audit_logs_compute_hash(), the same function the insert trigger uses).
//   modified row ........ row_hash does not match its content            → MODIFIED
//   deleted row ......... seq jumps / prev_hash does not match           → GAP / CHAIN_BROKEN
//   reordered / forged .. seq out of order, duplicated or prev mismatch  → OUT_OF_ORDER / CHAIN_BROKEN
//   rewritten baseline .. the row the baseline pointed at has changed    → BASELINE_MISMATCH
//   removed tail ........ only detectable against a head you stored elsewhere: pass expectHead { seq, hash }  → HEAD_MISMATCH
// Works with a Prisma client or an open transaction. Needs only SELECT on audit_logs.
const PAGE = 5000;
const MAX_PROBLEMS = 50;

async function verifyChain(db, { expectHead } = {}) {
  const problems = [];
  const add = (p) => { if (problems.length < MAX_PROBLEMS) problems.push(p); };
  let expectedSeq = 1; let prevHash = 'GENESIS'; let rows = 0; let last = null; let afterSeq = -1;
  for (;;) {
    const page = await db.$queryRaw`
      SELECT seq::text AS seq_text, id::text AS id, prev_hash, row_hash,
             audit_logs_compute_hash(seq, id, user_id, user_role::text, action, entity_type, entity_id, details, ip_address, user_agent, created_at, prev_hash) AS expected
        FROM audit_logs WHERE seq > ${afterSeq} ORDER BY seq LIMIT ${PAGE}`;
    if (!page.length) break;
    for (const r of page) {
      const seq = Number(r.seq_text);
      if (seq !== expectedSeq) add({ seq, id: r.id, type: seq < expectedSeq ? 'OUT_OF_ORDER' : 'GAP', detail: `expected seq ${expectedSeq}, found ${seq}` });
      if (r.prev_hash !== prevHash) add({ seq, id: r.id, type: 'CHAIN_BROKEN', detail: 'prev_hash does not match the previous row (a row was removed, inserted or moved)' });
      if (r.row_hash !== r.expected) add({ seq, id: r.id, type: 'MODIFIED', detail: 'row content does not match its hash' });
      expectedSeq = seq + 1; prevHash = r.row_hash; rows += 1; last = { seq, hash: r.row_hash };
      afterSeq = seq;
    }
  }
  const [baseline] = await db.$queryRaw`SELECT last_seq::text AS last_seq, last_hash, rows_covered::text AS rows_covered, established_at FROM audit_chain_baseline ORDER BY established_at LIMIT 1`;
  if (baseline) {
    const [row] = await db.$queryRaw`SELECT row_hash FROM audit_logs WHERE seq = ${Number(baseline.last_seq)}`;
    if (!row || row.row_hash !== baseline.last_hash) add({ seq: Number(baseline.last_seq), type: 'BASELINE_MISMATCH', detail: 'the row the baseline recorded is missing or has a different hash (history before the baseline was altered)' });
  }
  if (expectHead) {
    const at = await db.$queryRaw`SELECT row_hash FROM audit_logs WHERE seq = ${Number(expectHead.seq)}`;
    if (!at[0] || at[0].row_hash !== expectHead.hash) add({ seq: Number(expectHead.seq), type: 'HEAD_MISMATCH', detail: 'the stored head is missing or different' });
    else if (last && last.seq < Number(expectHead.seq)) add({ seq: last.seq, type: 'HEAD_MISMATCH', detail: 'the log ends before the stored head (rows removed from the end)' });
  }
  return { ok: problems.length === 0, rows, head: last, baseline: baseline ? { lastSeq: Number(baseline.last_seq), rowsCovered: Number(baseline.rows_covered), establishedAt: baseline.established_at } : null, problems };
}

module.exports = { verifyChain };
