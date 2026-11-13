// Per-account protection against password guessing. Complements the per-IP limiter (middleware/rateLimit.js),
// which a distributed attack can get around. After `maxFailures` failed logins for one email within the window,
// that email is locked for the lock period — even with the right password. Unknown emails are tracked the same way,
// so the response never reveals whether an account exists.
// State is in memory: it is per API instance and cleared on restart (like the per-IP limiter).
const { loginMaxFailures, loginLockMinutes } = require('../config/env');

const accounts = new Map(); // email -> { failures, windowStart, lockedUntil }
const MAX_TRACKED = 10000;

const windowMs = () => loginLockMinutes * 60 * 1000;
const key = (email) => String(email || '').trim().toLowerCase();

function prune(now) {
  for (const [k, a] of accounts) if (a.lockedUntil <= now && now - a.windowStart > windowMs()) accounts.delete(k);
}

/** Seconds until the account may try again, or 0 when it is not locked */
function lockedFor(email, now = Date.now()) {
  const a = accounts.get(key(email));
  return a && a.lockedUntil > now ? Math.ceil((a.lockedUntil - now) / 1000) : 0;
}

/** Records a failed attempt; returns the lock time in seconds when this failure locks the account */
function recordFailure(email, now = Date.now()) {
  if (accounts.size > MAX_TRACKED) prune(now);
  const k = key(email);
  let a = accounts.get(k);
  if (!a || now - a.windowStart > windowMs()) a = { failures: 0, windowStart: now, lockedUntil: 0 };
  a.failures += 1;
  if (a.failures >= loginMaxFailures) { a.lockedUntil = now + windowMs(); a.failures = 0; a.windowStart = now; }
  accounts.set(k, a);
  return lockedFor(k, now);
}

/** Forgets the account's failures (successful login, password reset by an admin) */
const clear = (email) => accounts.delete(key(email));

module.exports = { lockedFor, recordFailure, clear };
