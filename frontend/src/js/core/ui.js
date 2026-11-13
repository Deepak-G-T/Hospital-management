// Small UI behaviours shared by every page. Markup for toasts and the confirm dialog lives in partials/.
import { $, $$, getPath } from './dom.js';

/* ---------- Theme ---------- */
export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('theme', theme); } catch { /* storage unavailable */ }
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-theme-toggle]')) setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

/* ---------- Toasts ---------- */
const TOAST_ICON = { info: 'i-bell', success: 'i-check-circle-2', error: 'i-alert-triangle', emergency: 'i-siren' };
export function toast(message, type = 'info', ms) {
  const stack = $('#toasts');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast is-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `<svg class="icon"><use href="#${TOAST_ICON[type] || TOAST_ICON.info}"/></svg><span></span>`;
  el.querySelector('span').textContent = message;
  stack.append(el);
  setTimeout(() => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 260); }, ms || (type === 'emergency' ? 8000 : 4000));
}
// Server errors also show the request id, so a user can quote it and support can find the entry in the server log
export const errorToast = (err) => toast(`${err?.message || 'Something went wrong'}${err?.status >= 500 && err?.requestId ? ` (ref ${String(err.requestId).slice(0, 8)})` : ''}`, 'error');

/* ---------- Dialogs (native <dialog>) ---------- */
export function openDialog(dlg) {
  const d = typeof dlg === 'string' ? document.getElementById(dlg) : dlg;
  if (!d.open) d.showModal();
  return d;
}
export function closeDialog(dlg) {
  const d = typeof dlg === 'string' ? document.getElementById(dlg) : dlg;
  if (d?.open) d.close();
}
// [data-close] closes its dialog; clicking the dimmed backdrop closes too
document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close]');
  if (closer) { closeDialog(closer.closest('dialog')); return; }
  if (e.target instanceof HTMLDialogElement && e.target.classList.contains('modal')) {
    const r = e.target.querySelector('.modal-panel').getBoundingClientRect();
    if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) e.target.close();
  }
});

/**
 * Confirmation dialog. Resolves { reason } when confirmed, null when cancelled.
 * opts: title, message, confirmLabel, danger, reason (label for an optional note field)
 */
export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = false, reason } = {}) {
  const d = $('#confirm-dialog');
  $('[data-confirm-title]', d).textContent = title;
  $('[data-confirm-message]', d).textContent = message;
  const ok = $('[data-confirm-ok]', d);
  ok.textContent = confirmLabel;
  ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  const field = $('[data-confirm-reason]', d);
  field.hidden = !reason;
  $('label', field).textContent = reason || '';
  $('textarea', field).value = '';
  openDialog(d);
  return new Promise((resolve) => {
    const done = (val) => { ok.onclick = null; d.onclose = null; closeDialog(d); resolve(val); };
    ok.onclick = () => done({ reason: $('textarea', field).value.trim() || null });
    d.onclose = () => resolve(null);
  });
}

/* ---------- Buttons ---------- */
export function busy(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
}
/** Runs an async action with the button disabled; shows a toast on error. Returns the result or undefined. */
export async function withBusy(btn, fn, successMessage) {
  busy(btn, true);
  try {
    const r = await fn();
    if (successMessage) toast(typeof successMessage === 'function' ? successMessage(r) : successMessage, 'success');
    return r;
  } catch (err) { errorToast(err); return undefined; } finally { busy(btn, false); }
}

/* ---------- Tabs: <div class="tabs" data-tabs> <button class="tab" data-value="x"> ---------- */
export function tabs(el, onChange, initial) {
  const select = (value, fire = true) => {
    $$('[data-value]', el).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.value === value)));
    el.dataset.active = value;
    if (fire) onChange?.(value);
  };
  $$('[data-value]', el).forEach((b) => { b.type = 'button'; b.setAttribute('role', 'tab'); b.addEventListener('click', () => select(b.dataset.value)); });
  el.setAttribute('role', 'tablist');
  select(initial ?? $('[data-value]', el)?.dataset.value, false);
  return { select, get value() { return el.dataset.active; } };
}

/* ---------- Chart cards: chart ⇄ table toggle ---------- */
document.addEventListener('click', (e) => {
  const t = e.target.closest('.chart-toggle');
  if (!t) return;
  const card = t.closest('.chart-card');
  card.classList.toggle('show-table');
  t.setAttribute('aria-pressed', String(card.classList.contains('show-table')));
});

/* ---------- Numbers that count up ---------- */
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
export function countUp(el, target, duration = 700) {
  if (typeof target !== 'number' || !Number.isFinite(target) || reducedMotion()) { el.textContent = target ?? '—'; return; }
  const start = performance.now();
  const decimals = Number.isInteger(target) ? 0 : 2;
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = (target * (1 - (1 - t) ** 3)).toFixed(decimals);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
/** Fills every [data-stat="key"] inside root from an object, counting numbers up */
export function stats(root, values) {
  $$('[data-stat]', root).forEach((el) => {
    const v = getPath(values, el.dataset.stat); // data-stat="totals.totalDoctors"
    countUp(el, v ?? '—');
  });
}

/* ---------- Password visibility toggle ---------- */
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-toggle-password]');
  if (!b) return;
  const input = b.parentElement.querySelector('input');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  b.querySelector('use').setAttribute('href', show ? '#i-eye-off' : '#i-eye');
});

/* ---------- Pagination (partials/pager.html) ---------- */
// `pagination` is { page, limit, totalItems, totalPages, hasNextPage, hasPreviousPage } (totalItems was called `total` before)
export function pager(el, pagination, onPage) {
  if (!el) return;
  const p = pagination || { page: 1, totalPages: 0, totalItems: 0 };
  const totalItems = p.totalItems ?? p.total ?? 0;
  const hasPrev = p.hasPreviousPage ?? p.page > 1;
  const hasNext = p.hasNextPage ?? p.page < p.totalPages;
  el.hidden = !(p.totalPages > 1); // one page or none: nothing to turn
  el.querySelector('[data-pager-page]').textContent = `${p.page}/${p.totalPages}`;
  el.querySelector('[data-pager-total]').textContent = ` · ${totalItems} ${totalItems === 1 ? 'record' : 'records'}`;
  const prev = el.querySelector('[data-pager-prev]');
  const next = el.querySelector('[data-pager-next]');
  prev.disabled = !hasPrev;
  next.disabled = !hasNext;
  prev.onclick = () => onPage(p.page - 1);
  next.onclick = () => onPage(p.page + 1);
}
