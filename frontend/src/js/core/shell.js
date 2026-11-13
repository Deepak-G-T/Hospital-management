// Page bootstrap for the public site and the three portals (header, sidebar, bell, auth guard).
import { api, getToken, setToken, rememberRole } from './api.js';

export { rememberRole };
import { $, $$, render, itemOf } from './dom.js';
import { toast, errorToast } from './ui.js';
import { connect, onEvent } from './socket.js';
import { initials, greeting } from './format.js';
import { autoInit } from './auto.js';

export const ROLE_HOME = { ADMIN: '/admin', DOCTOR: '/doctor', PATIENT: '/patient' };
const ROLE_LABEL = { ADMIN: 'Administrator', DOCTOR: 'Doctor', PATIENT: 'Patient' };

function storedRole() { try { return localStorage.getItem('medicore_role'); } catch { return null; } }
const never = () => new Promise(() => {}); // page is navigating away

/** Marks the most specific matching link as the current page */
function markCurrent(links, path) {
  let best = null;
  links.forEach((a) => {
    const href = a.getAttribute('href');
    const match = a.hasAttribute('data-exact') ? path === href : path === href || path.startsWith(`${href}/`);
    if (match && (!best || href.length > best.getAttribute('href').length)) best = a;
  });
  links.forEach((a) => (a === best ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
}

export async function logout() {
  await api.post('/auth/logout').catch(() => {});
  setToken(null);
  rememberRole(null);
  location.href = '/login';
}

/* ---------- Public pages ---------- */
export function initPublic() {
  const header = $('.site-header');
  markCurrent($$('.site-nav a'), location.pathname.replace(/\/$/, '') || '/');
  const toggle = $('.menu-toggle');
  toggle?.addEventListener('click', () => {
    const open = header.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  const role = getToken() ? storedRole() : null;
  $$('[data-when-guest]').forEach((el) => { el.hidden = Boolean(role); });
  $$('[data-when-user]').forEach((el) => {
    el.hidden = !role;
    if (role && el.tagName === 'A') el.href = ROLE_HOME[role];
  });
  setTimeout(autoInit); // after the page script has registered its own source() options
  return { role };
}

/* ---------- Portal pages ---------- */
export async function initPortal({ roles } = {}) {
  const html = document.documentElement;
  if (!getToken()) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    return never();
  }
  let user;
  try {
    ({ user } = await api.raw('GET', '/auth/me'));
  } catch (err) {
    if (err.status !== 401) toast(`Could not load your session: ${err.message}`, 'error', 10000);
    return never();
  }
  if (roles && !roles.includes(user.role)) { location.replace(ROLE_HOME[user.role]); return never(); }
  rememberRole(user.role);
  html.dataset.role = user.role;

  // identity
  const name = user.profile?.fullName || user.email;
  const display = `${user.role === 'DOCTOR' ? 'Dr. ' : ''}${name}`;
  $$('[data-user-name]').forEach((el) => { el.textContent = display; });
  $$('[data-user-email]').forEach((el) => { el.textContent = user.email; });
  $$('[data-user-role]').forEach((el) => { el.textContent = ROLE_LABEL[user.role]; });
  $$('[data-user-avatar]').forEach((el) => { el.textContent = initials(name); });
  $$('[data-first-name]').forEach((el) => { el.textContent = name.split(' ')[0]; });
  $$('[data-greeting]').forEach((el) => { el.textContent = greeting(); });
  $$('[data-role-link]').forEach((a) => { a.href = `/${user.role.toLowerCase()}/${a.dataset.roleLink}`; });
  $$('[data-hide-admin]').forEach((el) => { el.hidden = user.role === 'ADMIN'; });

  // title + current menu item
  const title = document.body.dataset.title || document.title.split('·')[0].trim();
  document.title = `${title} · MediCore`;
  $('[data-page-title]').textContent = title;
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  $('[data-page-sub]').textContent = `${ROLE_LABEL[user.role]} portal · ${today}`;
  const path = location.pathname.replace(/\/$/, '');
  $$(`[data-nav="${user.role}"]`).forEach((nav) => markCurrent($$('a[href]', nav), path));

  // sidebar collapse (remembered) + phone drawer
  try { if (localStorage.getItem('medicore_sidebar_collapsed') === '1') html.classList.add('sidebar-collapsed'); } catch { /* ignore */ }
  $('.collapse-btn')?.addEventListener('click', () => {
    const collapsed = html.classList.toggle('sidebar-collapsed');
    try { localStorage.setItem('medicore_sidebar_collapsed', collapsed ? '1' : '0'); } catch { /* ignore */ }
  });
  const drawer = (open) => html.classList.toggle('drawer-open', open);
  $$('[data-open-menu]').forEach((b) => b.addEventListener('click', () => drawer(true)));
  $$('[data-close-menu]').forEach((b) => b.addEventListener('click', () => drawer(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') drawer(false); });
  $$('.sidebar a').forEach((a) => a.addEventListener('click', () => drawer(false)));

  // popovers (account menu, notifications)
  const pops = $$('[data-popover]');
  pops.forEach((wrap) => {
    const btn = $('[data-popover-btn]', wrap);
    const panel = $('[data-popover-panel]', wrap);
    btn.addEventListener('click', () => {
      const open = panel.hidden;
      pops.forEach((p) => { $('[data-popover-panel]', p).hidden = true; });
      panel.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    });
  });
  document.addEventListener('mousedown', (e) => pops.forEach((wrap) => {
    if (!wrap.contains(e.target)) $('[data-popover-panel]', wrap).hidden = true;
  }));
  $$('[data-logout]').forEach((b) => b.addEventListener('click', logout));

  // live connection + notifications
  const socket = connect();
  const bell = setupBell(user.role);
  let connectedBefore = false;
  socket.on('connect', () => {
    html.classList.add('is-live');
    // Events sent while offline are not replayed by Socket.IO; notifications are stored, so reload what was missed
    if (connectedBefore) { bell.reload(); window.dispatchEvent(new Event('live:reconnected')); }
    connectedBefore = true;
  });
  socket.on('disconnect', () => html.classList.remove('is-live'));
  onEvent('notification:new', (n) => {
    bell.add(n);
    toast(n.title, n.type === 'EMERGENCY' ? 'emergency' : 'info');
  });
  onEvent(['emergency:alert', 'emergency:new'], () => {
    if (!location.pathname.includes('emergenc')) html.classList.add('has-emergency');
  });

  setTimeout(autoInit);
  return { user, on: onEvent };
}

function setupBell(role) {
  const wrap = $('[data-bell]');
  const list = $('[data-bell-list]', wrap);
  const badge = $('[data-bell-badge]', wrap);
  const btn = $('[data-popover-btn]', wrap);
  let items = [];
  let unread = 0;
  const paint = () => {
    badge.textContent = unread > 99 ? '99+' : unread;
    badge.classList.toggle('is-visible', unread > 0);
    btn.setAttribute('aria-label', `Notifications (${unread} unread)`);
    $('[data-bell-markall]', wrap).hidden = unread === 0;
    $('[data-bell-empty]', wrap).hidden = items.length > 0;
    render(list, 'tpl-bell-item', items);
  };
  const load = async () => {
    try {
      const res = await api.get('/notifications', { limit: 8 });
      items = res.items;
      unread = res.unread;
      paint();
    } catch { /* the bell is optional */ }
  };
  list.addEventListener('click', async (e) => {
    const row = e.target.closest('.bell-item');
    if (!row) return;
    const n = itemOf(row);
    if (!n.isRead) {
      await api.patch(`/notifications/${n.id}/read`).catch(() => {});
      const real = items.find((x) => x.id === n.id);
      if (real) real.isRead = true;
      unread = Math.max(0, unread - 1);
      paint();
    }
    if (n.link) location.href = n.link;
  });
  $('[data-bell-markall]', wrap).addEventListener('click', async () => {
    try {
      await api.patch('/notifications/read-all');
      items.forEach((n) => { n.isRead = true; });
      unread = 0;
      paint();
    } catch (err) { errorToast(err); }
  });
  $('[data-bell-viewall]', wrap).href = `/${role.toLowerCase()}/notifications`;
  load();
  return { add(n) { items = [n, ...items].slice(0, 8); unread += 1; paint(); }, reload: load };
}
