// Date helpers. Appointment times are generated in the server's local timezone
// (set TZ in the environment to the hospital's timezone) and stored as TIMESTAMPTZ.

function parseDateOnly(str) {
  // "YYYY-MM-DD" -> local midnight
  const [y, m, d] = String(str).split('-').map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d, 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}
function combineDateTime(dateStr, hhmm) {
  const base = parseDateOnly(dateStr);
  if (!base) return null;
  const [h, min] = hhmm.split(':').map(Number);
  base.setHours(h, min, 0, 0);
  return base;
}
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d = new Date()) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }
function startOfWeek(d = new Date()) { const x = startOfDay(d); x.setDate(x.getDate() - x.getDay()); return x; }
function startOfMonth(d = new Date()) { const x = startOfDay(d); x.setDate(1); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function formatDateKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

// Resolve a {from, to} range from query strings, defaulting to the last `defaultDays` days
function resolveRange(query, defaultDays = 30) {
  const to = query.to ? endOfDay(parseDateOnly(query.to) || new Date()) : endOfDay(new Date());
  const from = query.from ? startOfDay(parseDateOnly(query.from) || new Date()) : startOfDay(addDays(to, -(defaultDays - 1)));
  return { from, to };
}

module.exports = {
  parseDateOnly, combineDateTime, toMinutes, startOfDay, endOfDay, startOfWeek, startOfMonth, addDays, formatDateKey, resolveRange,
};
