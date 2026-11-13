/* eslint-disable no-console */
// Browser sweep: visits every route for every role at desktop + phone widths.
// Fails on console errors, page errors, error states, or any horizontal overflow.
// Usage: node tests/ui-sweep.cjs [screenshotDir]   (needs API on :5000 and Vite on :5173, seeded DB)
const { chromium } = require('playwright');

const B = process.env.WEB_URL || 'http://localhost:5173';
const SHOTS = process.argv[2];
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null; // e.g. ONLY='/admin/doctors' for a quick targeted run
const ROLES = {
  ADMIN: ['admin@medicore.com', 'Admin@123', ['/admin', '/admin/doctors', '/admin/patients', '/admin/departments', '/admin/appointments', '/admin/emergencies', '/admin/complaints', '/admin/users', '/admin/activity', '/admin/reports', '/admin/notifications', '/admin/audit-logs', '/admin/settings']],
  DOCTOR: ['david.chen@medicore.com', 'Doctor@123', ['/doctor', '/doctor/appointments', '/doctor/schedule', '/doctor/patients', '/doctor/prescriptions', '/doctor/emergencies', '/doctor/referrals', '/doctor/messages', '/doctor/reviews', '/doctor/complaints', '/doctor/notifications', '/doctor/profile', '/doctor/settings']],
  PATIENT: ['patient@medicore.com', 'Patient@123', ['/patient', '/patient/find-doctors', '/patient/appointments', '/patient/medical-profile', '/patient/reports', '/patient/emergency', '/patient/prescriptions', '/patient/reviews', '/patient/complaints', '/patient/notifications', '/patient/profile', '/patient/settings']],
};
const PUBLIC = ['/', '/about', '/departments', '/doctors', '/contact', '/login', '/register', '/does-not-exist'];
// THEME=dark runs everything in dark mode; MOTION=reduce emulates prefers-reduced-motion
const EXTRA = { colorScheme: process.env.THEME === 'dark' ? 'dark' : 'light', reducedMotion: process.env.MOTION === 'reduce' ? 'reduce' : 'no-preference' };
const VIEWPORTS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: 'phone390', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
  { name: 'phone360', viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
];

const problems = [];
let checked = 0;
let tableViews = 0;

async function checkPage(p, label, deviceWidth) {
  checked += 1;
  const res = await p.evaluate((dw) => {
    const vw = dw; // the real device width — mobile browsers widen innerWidth when content overflows
    const doc = document.documentElement.scrollWidth;
    const offenders = [];
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      // ignore things inside an intentionally scrollable container
      let n = el.parentElement; let inScroller = false;
      while (n && n !== document.body) { const s = getComputedStyle(n); if (['auto', 'scroll'].includes(s.overflowX) && n.scrollWidth > n.clientWidth - 1) { inScroller = true; break; } if (s.overflowX === 'hidden') { inScroller = true; break; } n = n.parentElement; }
      if (!inScroller && (r.right > vw + 1 || r.left < -1) && getComputedStyle(el).position !== 'fixed') offenders.push(`${el.tagName}.${String(el.className).slice(0, 60)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
    });
    const tinyIcons = [...document.querySelectorAll('button svg, a svg')].filter((svg) => {
      const r = svg.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (r.width < 12 || r.height < 12) && !svg.parentElement.closest('[aria-hidden="true"]');
    }).length;
    // Tables: cards on phones (header hidden, rows as blocks), normal tables on desktop
    const tables = [...document.querySelectorAll('table.table')].filter((t) => t.getBoundingClientRect().height > 0);
    const phone = dw < 768;
    const badTables = tables.filter((t) => {
      const head = t.querySelector('thead');
      const headShown = head && getComputedStyle(head).display !== 'none';
      const row = t.querySelector('tbody tr');
      const rowDisplay = row ? getComputedStyle(row).display : 'table-row';
      return phone ? (headShown || rowDisplay === 'table-row') : (!headShown || rowDisplay !== 'table-row');
    }).length;
    const errorState = !!document.querySelector('[data-error-state]') || /Failed to load data/.test(document.body.innerText);
    return { vw, doc: Math.max(document.documentElement.scrollWidth, window.innerWidth), offenders: offenders.slice(0, 3), errorState, tinyIcons, tables: tables.length, badTables };
  }, deviceWidth);
  if (res.doc > res.vw) problems.push(`${label}: page width ${res.doc} > viewport ${res.vw} :: ${res.offenders.join(' ; ')}`);
  else if (res.offenders.length) problems.push(`${label}: elements past viewport :: ${res.offenders.join(' ; ')}`);
  if (res.errorState) problems.push(`${label}: error state shown`);
  if (res.badTables) problems.push(`${label}: ${res.badTables} of ${res.tables} table(s) not in the expected ${deviceWidth < 768 ? 'card' : 'table'} layout`);
  tableViews += res.tables;
  if (res.tinyIcons) problems.push(`${label}: ${res.tinyIcons} squashed icon(s) (<12px) inside buttons/links`);
}

function watch(p, label) {
  p.on('pageerror', (e) => problems.push(`${label()}: pageerror ${e.message}`));
  p.on('console', (m) => {
    // In production (Nginx) the not-found page is served with a real HTTP 404, which Chrome logs; that is expected there only
    const expected404 = / \/does-not-exist$/.test(label()) && /status of 404/.test(m.text());
    if (m.type() === 'error' && !expected404 && !/favicon|fonts\.g|ERR_NETWORK_CHANGED/.test(m.text())) problems.push(`${label()}: console ${m.text().slice(0, 160)}`);
  });
}

(async () => {
  const browser = await chromium.launch();
  for (const vp of VIEWPORTS) {
    // public pages
    const pc = await browser.newContext({ ...vp, ...EXTRA }); const pp = await pc.newPage();
    let cur = '';
    watch(pp, () => `${vp.name} ${cur}`);
    for (const r of PUBLIC.filter((x) => !ONLY || ONLY.test(x))) { cur = r; await pp.goto(B + r, { waitUntil: 'networkidle' }); await pp.waitForTimeout(400); await checkPage(pp, `${vp.name} ${r}`, vp.viewport.width); }
    await pc.close();
    for (const [role, [email, pw, routes]] of Object.entries(ROLES)) {
      const c = await browser.newContext({ ...vp, ...EXTRA }); const p = await c.newPage();
      watch(p, () => `${vp.name} ${cur}`);
      cur = '/login';
      await p.goto(B + '/login', { waitUntil: 'networkidle' });
      await p.fill('input[type=email]', email); await p.fill('input[type=password]', pw);
      await p.click('button[type=submit]'); await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
      for (const r of routes.filter((x) => !ONLY || ONLY.test(x))) {
        cur = r;
        await p.goto(B + r, { waitUntil: 'networkidle' });
        await p.waitForTimeout(700);
        await checkPage(p, `${vp.name} ${r}`, vp.viewport.width);
        if (SHOTS && (r === routes[0] || /appointments$|emergenc|doctors$|medical-profile/.test(r))) {
          await p.screenshot({ path: `${SHOTS}/${vp.name}_${r.replace(/\//g, '_')}.png`, fullPage: vp.name !== 'desktop' && r === routes[0] });
        }
      }
      await c.close();
    }
  }
  await browser.close();
  console.log(`[${EXTRA.colorScheme} mode, motion: ${EXTRA.reducedMotion}] Checked ${checked} page views (${tableViews} table renders verified)`);
  if (problems.length) { console.log(`${problems.length} PROBLEM(S):\n${[...new Set(problems)].join('\n')}`); process.exit(1); }
  console.log('UI SWEEP PASSED: no console errors, no error states, no horizontal overflow');
})();
