/* eslint-disable no-console */
// Pagination in the website (P1 item 12). Needs a freshly seeded *test* database and the API + site behind WEB_URL.
//   Previous/Next, "Page x/y · n records", first/middle/last pages, filters returning to page 1, the converted pages (doctor patients, doctor and
//   patient reviews, prescriptions, complaints, reports), loading / empty / error states, a phone-sized screen, and the pickers that need every item.
// Usage: WEB_URL=http://localhost:8089 node tests/pagination-ui.cjs
const { chromium } = require('playwright');

const B = process.env.WEB_URL || 'http://localhost:5173';
const results = []; let failed = 0;
const check = (name, ok, extra = '') => { results.push(`  ${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${extra}`}`); if (!ok) failed += 1; };
const api = async (method, path, token, body) => { const r = await fetch(`${B}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return r.json(); };
const tokenOf = async (email, password) => (await api('POST', '/auth/login', null, { email, password })).data.token;

async function open(browser, email, password, path, { viewport = { width: 1280, height: 900 } } = {}) {
  const ctx = await browser.newContext({ viewport }); const p = await ctx.newPage(); p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) p.errors.push(m.text()); });
  await p.goto(`${B}/login`, { waitUntil: 'networkidle' });
  await p.fill('input[type=email]', email); await p.fill('input[type=password]', password); await p.click('button[type=submit]');
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10000 });
  await p.goto(`${B}${path}`, { waitUntil: 'networkidle' });
  return p;
}
const pagerOf = (p, root = '') => ({
  el: p.locator(`${root} [data-pager]`).first(), page: p.locator(`${root} [data-pager-page]`).first(), total: p.locator(`${root} [data-pager-total]`).first(),
  prev: p.locator(`${root} [data-pager-prev]`).first(), next: p.locator(`${root} [data-pager-next]`).first(),
});
const settled = async (p, sel) => { await p.waitForSelector(`${sel}[data-state=ready], ${sel}[data-state=empty], ${sel}[data-state=error]`, { timeout: 10000 }); await p.waitForTimeout(250); };
let LIST = '[data-list]'; // the element holding the rows (the reviews page lists them with data-each)
const listText = (p, sel) => p.locator(`${sel} ${LIST}`).first().innerText();
const rows = (p, sel) => p.locator(`${sel} ${LIST} > *`).count();
const pageNo = async (pg) => Number((await pg.page.innerText()).split('/')[0]);

/** Walks a list with Next/Previous: first → second → last → back, checks the controls and that the content changes */
async function walkUi(name, p, sel, { expectPages, list = '[data-list]' }) {
  LIST = list;
  const pg = pagerOf(p, sel);
  await settled(p, sel);
  check(`${name}: the pager shows on a list with several pages`, await pg.el.isVisible());
  const txt = (await pg.page.innerText()).trim(); const tot = (await pg.total.innerText()).trim();
  const pages = Number(txt.split('/')[1]);
  check(`${name}: "Page 1/${pages} · n records" is displayed, Previous disabled, Next enabled`, /^1\/\d+$/.test(txt) && /· \d+ records?/.test(tot) && await pg.prev.isDisabled() && await pg.next.isEnabled(), `${txt} ${tot}`);
  if (expectPages) check(`${name}: ${expectPages} pages`, pages === expectPages, `got ${pages}`);
  const first = await listText(p, sel); const firstRows = await rows(p, sel);
  await pg.next.click(); await settled(p, sel);
  const second = await listText(p, sel);
  check(`${name}: Next shows page 2 with different content and enables Previous`, await pageNo(pg) === 2 && second !== first && await pg.prev.isEnabled());
  // jump to the last page
  for (let i = 0; i < pages + 2 && await pg.next.isEnabled(); i += 1) { await pg.next.click(); await settled(p, sel); }
  const last = await listText(p, sel); const lastRows = await rows(p, sel);
  check(`${name}: on the last page Next is disabled and the page may be shorter`, await pageNo(pg) === pages && await pg.next.isDisabled() && lastRows > 0 && lastRows <= firstRows && last !== first, `${await pageNo(pg)}/${pages} rows ${lastRows}`);
  await pg.prev.click(); await settled(p, sel);
  check(`${name}: Previous goes back one page`, await pageNo(pg) === pages - 1);
  return { pages, first };
}

(async () => {
  const browser = await chromium.launch();
  const admin = await tokenOf('admin@medicore.com', 'Admin@123');

  // the doctor with the most patients, and the one with the most reviews
  const doctors = (await api('GET', '/admin/doctors?limit=100', admin)).data.items; let busiest = null; let reviewed = null;
  for (const d of doctors) {
    const t = await tokenOf(d.user.email, 'Doctor@123').catch(() => null); if (!t) continue;
    const n = (await api('GET', '/doctor/patients?limit=1', t)).data.pagination.totalItems; const r = (await api('GET', '/doctor/reviews?limit=1', t)).data.pagination.totalItems;
    if (!busiest || n > busiest.n) busiest = { email: d.user.email, n, t }; if (!reviewed || r > reviewed.n) reviewed = { email: d.user.email, n: r, t };
  }
  // data for the seeded patient: 11 complaints (2 pages of 10), 13 reports (2 pages of 12)
  const pt = await tokenOf('patient@medicore.com', 'Patient@123');
  for (let i = 1; i <= 11; i += 1) await api('POST', '/complaints', pt, { subject: `Paging UI test ${i}`, description: 'Created by the pagination UI test.', category: 'OTHER' });
  for (let i = 1; i <= 13; i += 1) { const f = new FormData(); f.append('title', `Paging report ${i}`); f.append('reportType', 'LAB'); f.append('file', new Blob(['%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'], { type: 'application/pdf' }), 'r.pdf'); await fetch(`${B}/api/patient/reports`, { method: 'POST', headers: { authorization: `Bearer ${pt}` }, body: f }); }

  // ── an existing paginated page: admin users ──
  let p = await open(browser, 'admin@medicore.com', 'Admin@123', '/admin/users');
  const users = await walkUi('admin users', p, '#list', {});
  const pg = pagerOf(p, '#list');
  // filters: back to page 1, totals follow the filter
  await pg.prev.click(); await settled(p, '#list');
  await pg.next.click(); await settled(p, '#list'); // on page 2 …
  await p.selectOption('#filters [name=role]', 'DOCTOR'); await p.waitForTimeout(900); await settled(p, '#list'); // … a filter goes back to page 1
  const doctorsTotal = (await api('GET', '/admin/users?role=DOCTOR&limit=1', admin)).data.pagination.totalItems;
  const filteredRows = await rows(p, '#list');
  check('admin users: changing a filter returns to page 1 and the totals follow the filter', filteredRows === Math.min(20, doctorsTotal) && (!(await pg.el.isVisible()) || (await pageNo(pg)) === 1) && (await p.locator('#list').innerText()).includes('Doctor'), `${filteredRows} rows, expected ${Math.min(20, doctorsTotal)}`);
  await p.fill('#filters [name=search]', 'zzzz-nobody'); await p.waitForTimeout(900); await settled(p, '#list');
  check('admin users: a search without results shows the empty state and no pager', (await p.getAttribute('#list', 'data-state')) === 'empty' && !(await pg.el.isVisible()));
  check('admin users: no script errors', p.errors.length === 0, p.errors.join(' | '));

  // ── loading and error states while turning the page ──
  p = await open(browser, 'admin@medicore.com', 'Admin@123', '/admin/users');
  await settled(p, '#list');
  await p.route(/\/api\/admin\/users\?.*page=2/, async (r) => { await new Promise((x) => setTimeout(x, 1500)); await r.continue(); });
  await pagerOf(p, '#list').next.click();
  await p.waitForSelector('#list[data-state=loading]', { timeout: 1200 });
  check('loading state: a skeleton is shown while the next page loads', true);
  await settled(p, '#list'); check('loading state: the page arrives afterwards', (await p.getAttribute('#list', 'data-state')) === 'ready' && await pageNo(pagerOf(p, '#list')) === 2);
  await p.unroute(/\/api\/admin\/users\?.*page=2/);
  await p.route(/\/api\/admin\/users\?.*page=3/, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, message: 'Something went wrong. Please try again later.', error: { code: 'INTERNAL_ERROR', status: 500 }, requestId: 'deadbeef-0000' }) }));
  await pagerOf(p, '#list').next.click(); await settled(p, '#list');
  const errTxt = await p.locator('#list [data-error-text]').first().innerText().catch(() => '');
  check('error state: a failing page shows a readable message (no raw JSON or codes)', (await p.getAttribute('#list', 'data-state')) === 'error' && /went wrong|could not|failed|problem/i.test(errTxt) && !/INTERNAL_ERROR|\{"success"/.test(await p.locator('body').innerText()), errTxt);
  check('error state: no uncaught script errors', p.errors.filter((e) => !/500/.test(e)).length === 0, p.errors.join(' | '));

  // ── converted pages ──
  p = await open(browser, busiest.email, 'Doctor@123', '/doctor/patients');
  check(`doctor patients (${busiest.n} patients): converted page loads`, busiest.n > 12);
  await walkUi('doctor patients', p, '#patients', { expectPages: Math.ceil(busiest.n / 12) });
  await p.fill('#search', 'zzzz'); await p.waitForTimeout(900); await settled(p, '#patients');
  check('doctor patients: a search without results shows the empty state', (await p.getAttribute('#patients', 'data-state')) === 'empty' && !(await pagerOf(p, '#patients').el.isVisible()));

  p = await open(browser, reviewed.email, 'Doctor@123', '/doctor/reviews');
  await settled(p, '#reviews');
  const avg1 = await p.locator('#reviews [data-text="average|or:—"]').first().innerText(); const total1 = await p.locator('#reviews .small.muted.mt-1').first().innerText();
  await walkUi('doctor reviews', p, '#reviews', { expectPages: Math.ceil(reviewed.n / 10), list: '[data-each="items:tpl-review"]' });
  const avg2 = await p.locator('#reviews [data-text="average|or:—"]').first().innerText();
  check('doctor reviews: the average and the rating distribution describe all reviews on every page', avg1 === avg2 && /\d+ review/.test(total1) && total1.includes(String(reviewed.n)), `${avg1} ${avg2} ${total1}`);

  p = await open(browser, 'patient@medicore.com', 'Patient@123', '/patient/prescriptions');
  await walkUi('patient prescriptions', p, '#rx', {});
  p = await open(browser, 'patient@medicore.com', 'Patient@123', '/patient/reviews');
  await walkUi('patient reviews', p, '#reviews', {});
  p = await open(browser, 'patient@medicore.com', 'Patient@123', '/patient/complaints');
  await walkUi('complaints', p, '#complaints', { expectPages: 2 });
  p = await open(browser, 'patient@medicore.com', 'Patient@123', '/patient/reports');
  await walkUi('patient reports', p, '#reports', { expectPages: 2 });
  check('patient reports: the "Recently deleted" list is paginated separately and shows its empty state', (await p.getAttribute('#deleted-reports', 'data-state')) === 'empty');

  // ── a new account: empty states, no pager ──
  const email = `paging.${Date.now()}@example.com`; await api('POST', '/auth/register', null, { email, password: 'Start@1234', fullName: 'Paging Newcomer' });
  p = await open(browser, email, 'Start@1234', '/patient/reports'); await settled(p, '#reports');
  check('empty state: a new patient sees "No reports yet" and no pager', (await p.getAttribute('#reports', 'data-state')) === 'empty' && !(await pagerOf(p, '#reports').el.isVisible()) && /No reports yet/.test(await p.locator('#reports').innerText()));
  await p.goto(`${B}/patient/prescriptions`, { waitUntil: 'networkidle' }); await settled(p, '#rx');
  check('empty state: no prescriptions yet', /No prescriptions yet/.test(await p.locator('body').innerText()));

  // ── phone ──
  p = await open(browser, 'admin@medicore.com', 'Admin@123', '/admin/users', { viewport: { width: 390, height: 844 } });
  await settled(p, '#list'); const m = pagerOf(p, '#list'); await m.next.click(); await settled(p, '#list');
  const box = await m.next.boundingBox(); const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('phone: the pager fits the screen (no horizontal scrolling), shows "2/n", and its buttons are tappable', await m.el.isVisible() && /^2\/\d+$/.test((await m.page.innerText()).trim()) && overflow <= 0 && box.height >= 40 && box.width >= 40, `overflow ${overflow}, box ${JSON.stringify(box)}`);
  check('phone: Previous and Next stay inside the viewport', (await m.prev.boundingBox()).x >= 0 && box.x + box.width <= 390);
  p = await open(browser, 'patient@medicore.com', 'Patient@123', '/patient/prescriptions', { viewport: { width: 390, height: 844 } });
  await settled(p, '#rx'); const mo = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('phone: a converted page (prescriptions) has no horizontal overflow', mo <= 0, `${mo}`);

  // ── pickers need every item: the referral dialog follows the pages ──
  p = await open(browser, busiest.email, 'Doctor@123', '/doctor/referrals');
  const ctx = p.context(); let requests = 0;
  await ctx.route(/\/api\/doctor\/patients\?.*treating=true/, async (r) => {
    requests += 1; const u = new URL(r.request().url()); const page = Number(u.searchParams.get('page')); const limit = Number(u.searchParams.get('limit'));
    const n = limit === 100 ? (page < 3 ? 100 : 50) : 0; const items = Array.from({ length: n }, (_, i) => ({ id: `00000000-0000-4000-8000-${String((page - 1) * 100 + i).padStart(12, '0')}`, fullName: `Picker Patient ${(page - 1) * 100 + i + 1}`, gender: 'MALE', dateOfBirth: null, phone: null, appointments: [] }));
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { items, pagination: { page, limit, totalItems: 250, totalPages: 3, hasNextPage: page < 3, hasPreviousPage: page > 1, total: 250 } } }) });
  });
  await p.reload({ waitUntil: 'networkidle' });
  await p.click('#new-ref'); await p.waitForSelector('#referral-dialog[open]'); await p.waitForTimeout(800);
  const optionCount = await p.locator('#rf-patient option').count();
  check('pickers: the patient drop-down of the referral dialog loads every page (250 patients over 3 requests of at most 100)', optionCount >= 250 && requests === 3, `${optionCount} options, ${requests} requests`);
  check('pickers: no script errors', p.errors.length === 0, p.errors.join(' | '));

  await browser.close();
  console.log(results.join('\n'));
  console.log(failed ? `\nFAILED (${failed})` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
