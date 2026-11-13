// Declarative page behaviour: pages say in HTML what to load and what forms/buttons do.
//
//   <div data-state="loading" data-source="/admin/users" data-template="tpl-row" data-filters="#filters" data-limit="20" data-live="appointment:updated">
//       loads, renders into [data-list] (or binds one object to .when-ready), pages with [data-pager];
//       data-filters: forms / tabs / inputs whose values become query parameters (reloads on change)
//   <form data-api="POST /admin/departments" data-api-edit="PUT /admin/departments/{id}" data-done="Saved" data-reset data-go="/next">
//   <button data-call="PATCH /x/{id}/status" data-body="status:CONFIRMED" data-confirm="Approve?" data-confirm-text="{name}"
//           data-reason="Note (optional)" data-danger data-done="Approved">
//   <button data-open="dialog-id" [data-new] [data-preset="status:ACTIVE"]>   fills the dialog and its form from the clicked row
//   data-where="cond" filters and data-sort="-field" sorts the loaded rows
//   <select data-options="/admin/departments" data-option-label="{name}" [data-items="path.in.response"]>
//   <button data-download="/files/x/{id}"> / <button data-view-file="/files/x/{id}">   protected files
//   <button data-reveal="/admin/patients/{id}">   asks for a reason (recorded in the audit log), then loads the record with it and shows the medical details
//   <div class="tabs" data-name="status" [data-param="tab"] [data-panels="#root"]>   behaves like an input named "status"
// <form data-keep-open> keeps its dialog open after success.
// Form fields: data-null ('' → null), data-number ('' → 0), data-match="otherField" (must be equal), <fieldset data-if> is disabled while hidden.
// Events: 'dialog:open' (detail = item) on the dialog, 'api:done' (detail = { result, item }) on the form/button.
import { api, download, openFile, setToken, rememberRole } from './api.js';
import { $, $$, render, load, bind, itemOf, formValues, setFormValues, interpolate, options, debounce, params, getPath, test } from './dom.js';
import { toDateInput } from './format.js';
import { pager, openDialog, closeDialog, confirmDialog, withBusy, tabs, toast, errorToast, stats } from './ui.js';
import { onEvent } from './socket.js';
import { dateRange } from './range.js';
import { drawCharts } from './charts.js';

const views = new Map();
const ready = new WeakSet();
const PATH = location.pathname.split('/').filter(Boolean);
const ctx = (item) => ({ ...item, path: PATH, pathEnd: PATH.at(-1) }); // {path.2}, {pathEnd} read the URL
const itemsOf = (r) => (Array.isArray(r) ? r : r?.items);

/* ---------- controls ---------- */
const controls = (el) => (el.tagName === 'FORM' ? [...el.elements] : el.name ? [el] : $$('[name]', el));
function filterValues(selector) {
  const out = {};
  if (selector) $$(selector).forEach((el) => Object.assign(out, el.tagName === 'FORM' ? formValues(el) : Object.fromEntries(controls(el).map((c) => [c.name, c.value]))));
  return out;
}
function initTabs(el) {
  if (ready.has(el)) return;
  ready.add(el);
  const { name, param, initial, panels } = el.dataset;
  const input = Object.assign(document.createElement('input'), { type: 'hidden', name });
  el.append(input);
  const values = $$('[data-value]', el).map((b) => b.dataset.value);
  const q = params()[param || name];
  const show = (v) => { input.value = v; if (panels) $$('[data-panel]', $(panels)).forEach((p) => { p.hidden = p.dataset.panel !== v; }); };
  const start = values.includes(q) ? q : initial ?? values[0];
  show(start);
  tabs(el, (v) => { show(v); input.dispatchEvent(new Event('change', { bubbles: true })); }, start);
}
function initOptions(sel) {
  if (ready.has(sel)) return;
  ready.add(sel);
  const keep = sel.options.length;
  const label = sel.dataset.optionLabel || '{name}';
  api.all(sel.dataset.options).then((r) => {
    sel.items = sel.dataset.items ? getPath(r, sel.dataset.items) : itemsOf(r);
    options(sel, sel.items, { label: (it) => interpolate(label, it), keep });
    if (sel.dataset.pending) { sel.value = sel.dataset.pending; delete sel.dataset.pending; }
  }).catch(() => {});
}
function initControls() {
  $$('input[data-max-today]').forEach((i) => { i.max = toDateInput(); });
  $$('[data-range]').forEach((r) => dateRange(r));
  $$('.tabs[data-name]').forEach(initTabs);
  $$('select[data-options]').forEach(initOptions);
}

/* ---------- lists / records ---------- */
/** Sets up a [data-source] element. opts: map(item), after(response, view), isEmpty(response), context (for {placeholders}) */
export function source(target, opts = {}) {
  const el = typeof target === 'string' ? $(target) : target;
  if (views.has(el)) return Object.assign(views.get(el), opts);
  initControls();
  const d = el.dataset;
  const list = el.hasAttribute('data-list') ? el : $('[data-list]', el);
  let page = 1;
  const view = { ...opts, data: null };
  view.reload = async ({ silent = false, first = false } = {}) => {
    if (first) page = 1;
    const query = { ...Object.fromEntries(new URLSearchParams(d.params || '')), ...filterValues(d.filters), ...(d.limit ? { page, limit: d.limit } : {}) };
    let res;
    try {
      res = await load(el, () => api.get(interpolate(d.source, ctx(view.context)), query), { silent, isEmpty: view.isEmpty || ((r) => (itemsOf(r) ? !itemsOf(r).filter((it) => !d.where || test(d.where, it)).length : !r)) });
    } catch { return; }
    view.data = res;
    const pgn = res?.pagination;
    if (d.limit && pgn && pgn.page > 1 && pgn.page > pgn.totalPages) { page = Math.max(1, pgn.totalPages); return view.reload({ silent }); }
    let items = d.where && itemsOf(res) ? itemsOf(res).filter((it) => test(d.where, it)) : itemsOf(res); // data-where="recordType=CONDITION"
    if (d.sort && items) { const key = d.sort.replace('-', ''); const dir = d.sort[0] === '-' ? -1 : 1; items = [...items].sort((a, b) => dir * ((a[key] || 0) - (b[key] || 0))); } // data-sort="-rating"
    if (items && d.template) render(list, d.template, view.map ? items.map(view.map) : items);
    else {
      const data = view.map ? view.map(res) : res;
      bind(el, data);
      $$('form[data-fill]', el).forEach((f) => setFormValues(f, data)); // e.g. a profile form
      stats(el, data); // [data-stat] counters
    }
    drawCharts(el, view.map && !items ? view.map(res) : res);
    if (d.limit) pager($('[data-pager]', el), res.pagination, (p) => { page = p; view.reload(); });
    view.after?.(res, view);
  };
  views.set(el, view);
  // prefill filters from the URL (e.g. ?status=PENDING) and reload when they change
  const again = debounce(() => view.reload({ first: true, silent: 'quiet' in d }), 250); // data-quiet: no skeleton on filter changes
  if (d.filters) {
    $$(d.filters).forEach((f) => {
      controls(f).forEach((c) => { if (c.name && params()[c.name] != null && c.type !== 'hidden') c.value = params()[c.name]; });
      f.addEventListener('input', again);
      f.addEventListener('change', again);
    });
  }
  if (d.live) onEvent(d.live.split(' '), () => view.reload({ silent: true }));
  if (!el.closest('dialog')) view.reload();
  return view;
}
export const reloadAll = () => views.forEach((v, el) => { if (!el.closest('dialog') || el.closest('dialog').open) v.reload({ silent: true }); });
window.addEventListener('live:reconnected', reloadAll); // after a dropped connection, lists catch up on missed updates

/** Runs once the page script has registered its own source() options */
export function autoInit() {
  initControls();
  $$('[data-source]').forEach((el) => { if (!views.has(el) && !el.closest('dialog')) source(el); });
}

/* ---------- API calls from forms and buttons ---------- */
const typed = (v) => ({ true: true, false: false, null: null }[v] ?? v);
const parsePairs = (spec, item) => Object.fromEntries((spec || '').split(';').filter(Boolean).map((pair) => {
  const i = pair.indexOf(':');
  return [pair.slice(0, i).trim(), typed(interpolate(pair.slice(i + 1).trim(), ctx(item)))];
}));
function send(spec, item, body, btn, done) {
  const [method, path] = spec.trim().split(/\s+/);
  const message = done && ((r) => interpolate(done, { ...ctx(item), ...(r && typeof r === 'object' ? r : {}) }));
  return withBusy(btn, () => api.raw(method, interpolate(path, ctx(item)), body), message);
}
function finish(el, result, item) {
  const d = el.dataset;
  el.dispatchEvent(new CustomEvent('api:done', { bubbles: true, detail: { result, item } }));
  // <form data-login>: the response carries a session token (sign-up, or the renewed token after a password change)
  if ('login' in d && result?.token) { setToken(result.token); if (result.user) rememberRole(result.user.role); }
  const url = d.go && interpolate(d.go, ctx(item));
  if (url) { location.href = url; return; }
  if (el.tagName === 'FORM') {
    if ('reset' in d) el.reset();
    if (el.closest('dialog') && !('keepOpen' in d)) closeDialog(el.closest('dialog'));
  }
  if (d.reload !== 'none') reloadAll();
}

function formBody(form) {
  if (form.enctype === 'multipart/form-data') return new FormData(form);
  const body = formValues(form);
  $$('[data-null]', form).forEach((f) => { if (body[f.name] === '') body[f.name] = null; });
  $$('[data-number]', form).forEach((f) => { if (f.name in body) body[f.name] = Number(body[f.name]) || 0; });
  return form.transform ? form.transform(body) : body; // optional page hook
}
document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.matches?.('form[data-no-submit]')) { e.preventDefault(); return; } // filter forms: Enter must not reload the page
  if (!form.matches?.('form[data-api]')) return;
  e.preventDefault();
  if (!form.reportValidity()) return;
  const mismatch = $$('[data-match]', form).find((f) => f.value !== form.elements[f.dataset.match].value);
  if (mismatch) { toast(mismatch.dataset.message || 'Values do not match', 'error'); return; }
  const big = $$('input[type=file][data-max-mb]', form).find((f) => f.files[0]?.size > f.dataset.maxMb * 1048576);
  if (big) { toast(`File must be ${big.dataset.maxMb} MB or smaller`, 'error'); return; }
  const item = itemOf(form) || {};
  const spec = (item.id && form.dataset.apiEdit) || form.dataset.api;
  const r = await send(spec, item, formBody(form), form.querySelector('[type=submit]'), (item.id && form.dataset.doneEdit) || form.dataset.done);
  if (r !== undefined) finish(form, r, item);
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-call], [data-open], [data-download], [data-view-file], [data-refresh], [data-reveal]');
  if (!btn || btn.disabled) return;
  e.preventDefault();
  const d = btn.dataset;
  if ('refresh' in d) { reloadAll(); return; }
  if (d.reveal) { // confidential details: a reason is required and recorded before they are shown
    const item = itemOf(btn) || {};
    const ok = await confirmDialog({
      title: 'Open medical details?', confirmLabel: 'Open details',
      message: 'These details are confidential. Your reason is recorded in the audit log together with what you open.',
      reason: 'Reason (required, at least 10 characters)',
    });
    if (!ok) return;
    if ((ok.reason || '').length < 10) { toast('Please give a reason of at least 10 characters', 'error'); return; }
    const r = await withBusy(btn, () => api.get(interpolate(d.reveal, ctx(item)), undefined, { reason: ok.reason }));
    if (r === undefined) return;
    const host = btn.closest('[data-source]');
    if (host) bind(host, r);
    btn.dispatchEvent(new CustomEvent('api:done', { bubbles: true, detail: { result: r, item } }));
    return;
  }
  if (d.download || d.viewFile) { // protected files need the auth header, so they go through fetch
    const path = interpolate(d.download || d.viewFile, ctx(itemOf(btn)));
    (d.download ? download(path) : openFile(path)).then(() => d.done && toast(d.done, 'success')).catch(errorToast);
    return;
  }
  if (d.open) {
    const item = 'new' in d ? parsePairs(d.preset, {}) : { ...(itemOf(btn) || {}) };
    const dlg = document.getElementById(d.open);
    bind(dlg, item);
    const fill = () => $$('form[data-fill]', dlg).forEach((f) => setFormValues(f, item));
    $$('form', dlg).forEach((f) => f.reset());
    fill();
    $$('fieldset[data-if], fieldset[data-if-not]', dlg).forEach((f) => { f.disabled = f.hidden; });
    // lists inside the dialog (e.g. checkboxes) load for this item, then the form is filled again
    Promise.all($$('[data-source]', dlg).map((s) => { source(s).context = item; return source(s).reload(); })).then(fill);
    dlg.dispatchEvent(new CustomEvent('dialog:open', { detail: item }));
    openDialog(dlg);
    return;
  }
  const item = itemOf(btn) || {};
  let body = parsePairs(d.body, item);
  if (d.confirm) {
    const ok = await confirmDialog({
      title: interpolate(d.confirm, ctx(item)), message: interpolate(d.confirmText || '', ctx(item)),
      confirmLabel: d.confirmOk || btn.textContent.trim() || 'Confirm', danger: 'danger' in d, reason: d.reason,
    });
    if (!ok) return;
    if (d.reason) body = { ...body, reason: ok.reason };
  }
  const r = await send(d.call, item, Object.keys(body).length ? body : undefined, btn, d.done);
  if (r !== undefined) finish(btn, r, item);
});

