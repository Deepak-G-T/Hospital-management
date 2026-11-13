// Automatic emergency escalation settings (environment variables). The targets are PROVISIONAL operational targets,
// not clinically validated response times; the hospital must approve them before production use.
//
//   ESCALATION_ENABLED         true/false. Default: on in development/test, OFF when NODE_ENV=production.
//   ESCALATION_APPROVAL_REF    Required in production in addition to ESCALATION_ENABLED=true: the hospital's approval
//                              reference (e.g. "Clinical governance 2026-11-12, item 4"). Without it the worker stays off.
//   ESCALATION_TARGETS         Minutes without acceptance before each escalation step, per priority.
//                              Default "CRITICAL=2,HIGH=5,MEDIUM=15,LOW=30" (decimals allowed, e.g. for tests).
//   ESCALATION_MAX_LEVEL       1–3 (default 3). Level 1 = department doctors, 2 = emergency department, 3 = all
//                              emergency-available doctors and administrators.
//   ESCALATION_POLL_SECONDS    How often each API instance checks for due escalations (default 15).
const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const DEFAULT_TARGETS = { CRITICAL: 2, HIGH: 5, MEDIUM: 15, LOW: 30 };
const LEVELS = {
  1: { key: 'DEPARTMENT', label: 'department doctors' },
  2: { key: 'EMERGENCY_DEPARTMENT', label: 'emergency department' },
  3: { key: 'ALL_AVAILABLE', label: 'all available doctors and administrators' },
};

function parseTargets(raw) {
  const targets = { ...DEFAULT_TARGETS };
  if (!raw) return targets;
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [k, v] = part.split('=').map((x) => x.trim());
    const minutes = Number(v);
    if (!PRIORITIES.includes(k?.toUpperCase()) || !(minutes > 0)) throw new Error(`Invalid ESCALATION_TARGETS entry "${part}" (expected e.g. CRITICAL=2)`);
    targets[k.toUpperCase()] = minutes;
  }
  return targets;
}

function loadEscalationConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const requested = env.ESCALATION_ENABLED == null || env.ESCALATION_ENABLED === '' ? !production : env.ESCALATION_ENABLED === 'true';
  const approvalRef = (env.ESCALATION_APPROVAL_REF || '').trim();
  const productionBlocked = production && requested && !approvalRef;
  const maxLevel = Math.min(3, Math.max(1, Number(env.ESCALATION_MAX_LEVEL) || 3));
  const pollSeconds = Math.max(0.1, Number(env.ESCALATION_POLL_SECONDS) || 15);
  let reason;
  if (productionBlocked) reason = 'ESCALATION_ENABLED=true but ESCALATION_APPROVAL_REF is missing (production requires a recorded hospital approval)';
  else if (!requested) reason = production ? 'off by default in production (pending hospital approval)' : 'ESCALATION_ENABLED=false';
  return {
    enabled: requested && !productionBlocked,
    production,
    requested,
    productionBlocked,
    approvalRef: approvalRef || null,
    reason: reason || null,
    targets: parseTargets(env.ESCALATION_TARGETS),
    maxLevel,
    pollSeconds,
    levels: LEVELS,
  };
}

const config = loadEscalationConfig();

/** Minutes until the next escalation for a priority */
const targetMinutes = (priority) => config.targets[priority];

module.exports = { config, loadEscalationConfig, targetMinutes, LEVELS, PRIORITIES, DEFAULT_TARGETS };
