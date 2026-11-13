// Formatting helpers (same output as the previous React version)
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const formatDate = (d) => (d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
export const formatDateTime = (d) => (d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
export const formatTime = (d) => (d ? new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—');
export const formatTimeStr = (hhmm) => {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
export function relativeTime(d) {
  if (!d) return '';
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.round(diff / 86400)}d ago`;
  return formatDate(d);
}
export const enumLabel = (v) => (v ? String(v).toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : '—');
export const bloodLabel = (v) => (v ? v.replace('_POS', '+').replace('_NEG', '−') : '—');
export const currency = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(v || 0));
export const fileSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
export function age(dob) {
  if (!dob) return null;
  const d = new Date(dob); const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  if (now < new Date(now.getFullYear(), d.getMonth(), d.getDate())) a -= 1;
  return a;
}
export const toDateInput = (d = new Date()) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const initials = (name = '') => name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
export const shortDate = (v) => {
  if (!v) return '';
  if (/^\d{4}-\d{2}$/.test(v)) return new Date(`${v}-01T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  return new Date(`${v}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
export function greeting(date = new Date()) {
  const h = date.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

const NOTIF_ICON = {
  APPOINTMENT: 'calendar-check', EMERGENCY: 'siren', COMPLAINT: 'message-square-warning', PRESCRIPTION: 'pill', REPORT: 'file-text',
  REFERRAL: 'arrow-right-left', MESSAGE: 'messages-square', REVIEW: 'star', SYSTEM: 'info',
};

// Named formatters usable from HTML: data-format="datetime"
export const FORMATS = {
  date: formatDate, datetime: formatDateTime, time: formatTime, timestr: formatTimeStr, relative: relativeTime, enum: enumLabel,
  blood: bloodLabel, currency, filesize: fileSize, age: (v) => age(v) ?? '—', initials, shortdate: shortDate, day: (v) => DAY_NAMES[v],
  uri: (v) => encodeURIComponent(v), days: (v) => v.map((d) => DAY_SHORT[d]).join(', '), json: (v) => JSON.stringify(v, null, 2), short: (v) => `${String(v).slice(0, 8)}…`,
  notif: (v) => `#i-${NOTIF_ICON[v] || 'bell'}`,
  icon: (v) => `#i-${String(v || 'Building2').replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Za-z])(\d)/g, '$1-$2').toLowerCase()}`,
  years: (v) => `${v} yrs`, dr: (v) => (v ? `Dr. ${v}` : '—'), lower: (v) => String(v ?? '').toLowerCase(),
};
