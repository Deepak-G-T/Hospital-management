// Tiny declarative binding layer: the markup lives in HTML <template>s, this file only fills it in.
//
// Attributes understood by fill():
//   data-text="path|format"        textContent ('—' when empty). Text with {path|format} placeholders is interpolated.
//   data-attr="href:/x/{id};title:{name}"   sets attributes (values interpolated)
//   data-if="cond" / data-if-not="cond"     hides the element; cond = path | !path | path=A,B | path!=A | path>N | date<now | path~A,B (contains), joined with &
//   formats: {path|date} … plus {path|or:fallback text}, {flag|pick:yes,no} and {list|pluck:key} (comma-joined)
//   data-badge="path"              status badge: sets data-status + human label
//   data-priority-of="path"        priority pill
//   data-initials="path"           avatar initials
//   data-stars="path"              CSS stars (--rating)
//   data-style="--w:{pct}"         inline custom properties
//   data-class="cond:className;…"  toggles classes
//   data-value="path"              form control value
//   data-each="path:tplId"         renders a nested array with another <template>
import { FORMATS, enumLabel } from './format.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const getPath = (obj, path) => (path === '.' ? obj : path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj));

const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
function formatValue(raw, spec) {
  const [fmt, arg] = (spec || '').split(/:(.*)/);
  if (fmt === 'or') return empty(raw) || raw === '—' ? arg : raw; // {description|or:No description}
  if (fmt === 'pick') { const [yes, no = ''] = arg.split(','); return raw ? yes : no; } // {isActive|pick:ACTIVE,INACTIVE}
  if (fmt === 'pluck') return (raw || []).map((x) => getPath(x, arg)).join(', '); // {items|pluck:medicineName}
  if (fmt && FORMATS[fmt]) return empty(raw) ? '—' : FORMATS[fmt](raw);
  return raw;
}
const resolve = (expr, data) => { const [path, ...fmts] = expr.split('|').map((s) => s.trim()); return fmts.reduce(formatValue, getPath(data, path)); };
export const interpolate = (str, data) => str.replace(/\{([^}]+)\}/g, (_, expr) => { const v = resolve(expr, data); return v == null ? '' : v; });
const valueOf = (spec, data) => (spec.includes('{') ? interpolate(spec, data) : getPath(data, spec));

export function test(cond, data) {
  const c = cond.trim();
  if (c.includes('&')) return c.split('&').every((part) => test(part, data));
  if (c.startsWith('!')) return !test(c.slice(1), data);
  const m = c.match(/^([\w.]+)\s*(!=|=|>|<|~)\s*(.+)$/);
  if (!m) { const v = getPath(data, c); return Array.isArray(v) ? v.length > 0 : Boolean(v); }
  const [, path, op, rhs] = m;
  const v = getPath(data, path);
  const num = (x) => (rhs === 'now' ? new Date(x).getTime() : Number(x)); // startAt<now compares dates
  const r = rhs === 'now' ? Date.now() : Number(rhs);
  if (op === '>') return num(v) > r;
  if (op === '<') return num(v) < r;
  if (op === '~') return rhs.split(',').some((s) => String(v ?? '').includes(s.trim())); // contains any
  const hit = rhs.split(',').map((s) => s.trim()).includes(String(v));
  return op === '=' ? hit : !hit;
}

function each(root, attr, fn) {
  if (root.hasAttribute?.(attr)) fn(root, root.getAttribute(attr));
  root.querySelectorAll(`[${attr}]`).forEach((el) => fn(el, el.getAttribute(attr)));
}

/** Fills root (an element or fragment) from data */
export function fill(root, data) {
  each(root, 'data-if', (el, c) => { el.hidden = !test(c, data); });
  each(root, 'data-if-not', (el, c) => { el.hidden = test(c, data); });
  each(root, 'data-text', (el, expr) => {
    const v = expr.includes('{') ? interpolate(expr, data) : resolve(expr, data);
    el.textContent = v == null || v === '' ? '—' : v;
  });
  each(root, 'data-attr', (el, spec) => spec.split(';').filter(Boolean).forEach((pair) => {
    const i = pair.indexOf(':'); el.setAttribute(pair.slice(0, i).trim(), interpolate(pair.slice(i + 1).trim(), data));
  }));
  each(root, 'data-badge', (el, path) => { const v = valueOf(path, data); el.className = 'badge'; el.dataset.status = v || ''; el.textContent = enumLabel(v); });
  each(root, 'data-priority-of', (el, path) => { const v = getPath(data, path); el.className = 'priority'; el.dataset.priority = v || ''; el.textContent = enumLabel(v); });
  each(root, 'data-initials', (el, path) => { el.textContent = FORMATS.initials(valueOf(path, data) || ''); });
  each(root, 'data-stars', (el, path) => { el.style.setProperty('--rating', Number(getPath(data, path)) || 0); el.setAttribute('aria-label', `${getPath(data, path) || 0} out of 5 stars`); el.setAttribute('role', 'img'); });
  each(root, 'data-style', (el, spec) => spec.split(';').filter(Boolean).forEach((pair) => {
    const i = pair.indexOf(':'); el.style.setProperty(pair.slice(0, i).trim(), interpolate(pair.slice(i + 1).trim(), data));
  }));
  each(root, 'data-class', (el, spec) => spec.split(';').filter(Boolean).forEach((pair) => {
    const i = pair.lastIndexOf(':'); el.classList.toggle(pair.slice(i + 1).trim(), test(pair.slice(0, i), data));
  }));
  each(root, 'data-value', (el, path) => { const v = getPath(data, path); if (el.type === 'checkbox') el.checked = Boolean(v); else el.value = v ?? ''; });
  // nested lists last, so the passes above never overwrite the nested items with the parent's data
  each(root, 'data-each', (el, spec) => { const [path, tpl] = spec.split(':'); render(el, tpl.trim(), getPath(data, path.trim()) || []); });
  return root;
}

const items = new WeakMap();
/** The data object an element was rendered from (closest rendered ancestor) */
export const itemOf = (el) => { let n = el; while (n && !items.has(n)) n = n.parentElement; return n ? items.get(n) : undefined; };

/** Clones <template id=tplId> once per item, fills it, appends to container (replacing old content) */
export function render(container, tplId, list, after) {
  const tpl = document.getElementById(tplId);
  if (!tpl) throw new Error(`Template #${tplId} not found`);
  const frag = document.createDocumentFragment();
  (list || []).forEach((item, i) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    fill(node, item);
    items.set(node, item);
    if (after) after(node, item, i);
    frag.append(node);
  });
  container.replaceChildren(frag);
  return container;
}

/** Fills a single (non-repeated) block and remembers its item for actions */
export function bind(el, item) { fill(el, item); items.set(el, item); return el; }

/** Delegated click actions: <button data-action="accept">; handler gets (item, button, event) */
export function actions(root, handlers) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !root.contains(btn) || btn.disabled) return;
    const fn = handlers[btn.dataset.action];
    if (fn) { e.preventDefault(); fn(itemOf(btn), btn, e); }
  });
}

/** Sets a container's load state (CSS shows .when-loading/.when-error/.when-empty/.when-ready) */
export function setState(el, state, message) {
  el.dataset.state = state;
  if (state === 'error') { const t = el.querySelector('[data-error-text]'); if (t) t.textContent = message || 'Failed to load data'; }
}

/** Runs loader with loading/empty/error states and a working "Try again" button */
export async function load(el, loader, { isEmpty = (d) => !d || (Array.isArray(d) && !d.length), silent = false } = {}) {
  if (!silent || !el.dataset.state) setState(el, 'loading');
  try {
    const data = await loader();
    setState(el, isEmpty(data) ? 'empty' : 'ready');
    return data;
  } catch (err) {
    setState(el, 'error', err.message);
    const retry = el.querySelector('[data-retry]');
    if (retry) retry.onclick = () => load(el, loader, { isEmpty });
    throw err;
  }
}

/** Form → plain object. number inputs → Number, checkboxes → boolean, name[] → array */
export function formValues(form) {
  const out = {};
  [...form.elements].forEach((el) => {
    if (!el.name || el.disabled || el.type === 'submit' || el.type === 'button' || el.type === 'file') return;
    if (el.name.endsWith('[]')) { const k = el.name.slice(0, -2); out[k] ||= []; if (el.checked) out[k].push(el.value); return; }
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else if (el.type === 'number') out[el.name] = el.value === '' ? '' : Number(el.value);
    else out[el.name] = el.value;
  });
  return out;
}

export function setFormValues(form, data) {
  [...form.elements].forEach((el) => {
    if (!el.name || el.type === 'file') return;
    const key = el.dataset.from || el.name.replace(/\[\]$/, ''); // data-from="user.email" reads nested data, "!x" negates
    const v = key[0] === '!' ? !getPath(data, key.slice(1)) : getPath(data, key);
    if (v === undefined) return; // only touch the fields we were given
    if (el.name.endsWith('[]')) { el.checked = (v || []).map(String).includes(el.value); return; }
    // a select without that option yet (options still loading) keeps it as pending; auto.js applies it later
    if (el.tagName === 'SELECT' && v != null && v !== '' && ![...el.options].some((o) => o.value === String(v))) { el.dataset.pending = v; return; }
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else if (el.type === 'radio') el.checked = String(v) === el.value;
    else if (el.type === 'date' && v) el.value = String(v).slice(0, 10);
    else el.value = v ?? '';
  });
}

/** Fills a <select> with options from a list */
export function options(select, list, { value = 'id', label = 'name', keep = 1 } = {}) {
  [...select.options].slice(keep).forEach((o) => o.remove());
  list.forEach((it) => select.add(new Option(typeof label === 'function' ? label(it) : it[label], it[value])));
}

export const params = () => Object.fromEntries(new URLSearchParams(location.search));
export const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
