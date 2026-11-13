// Polls PostgreSQL for emergencies whose automatic escalation is due (see services/escalation.service.js).
// Every API instance may run it: each due case is claimed with SELECT … FOR UPDATE SKIP LOCKED, so instances never
// escalate the same case twice. A crash mid-escalation rolls the transaction back and the case is retried on the next tick.
const { config } = require('../config/escalation');
const { escalateNextDue } = require('../services/escalation.service');

const MAX_PER_TICK = 100; // bounded work per tick; anything left is picked up on the next one

let timer = null;
let running = false;
let stopped = true;

async function tick() {
  if (running || stopped) return; // never overlap ticks within one instance
  running = true;
  try {
    for (let i = 0; i < MAX_PER_TICK && !stopped; i += 1) {
      const done = await escalateNextDue();
      if (!done) break;
      console.log(`[escalation] emergency ${done.id} escalated to level ${done.level}`);
    }
  } catch (err) {
    // Logged and retried on the next tick; the database state is unchanged for the failed case
    console.error('[escalation] tick failed:', err.message);
  } finally {
    running = false;
  }
}

/** Starts the worker when allowed by configuration. Returns true when it is running. */
function start() {
  if (!config.enabled) {
    console.log(`[escalation] automatic emergency escalation is OFF: ${config.reason}`);
    return false;
  }
  if (timer) return true;
  stopped = false;
  const targets = Object.entries(config.targets).map(([p, m]) => `${p}=${m}m`).join(' ');
  console.log(`[escalation] automatic emergency escalation is ON (provisional targets ${targets}; max level ${config.maxLevel}; poll ${config.pollSeconds}s${config.approvalRef ? `; approval: ${config.approvalRef}` : ''})`);
  timer = setInterval(tick, config.pollSeconds * 1000);
  timer.unref();
  setImmediate(tick);
  return true;
}

/** Stops polling and waits (briefly) for an in-flight tick to finish */
async function stop() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
  for (let i = 0; running && i < 100; i += 1) await new Promise((r) => setTimeout(r, 50));
}

module.exports = { start, stop, tick };
