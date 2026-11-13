/* eslint-disable no-console */
// Privacy changes through the real UI. Needs a freshly seeded *test* database and API.
//   admin patients: no Blood column / allergy counts; registration still takes a blood group; editing one field never
//                   erases the others; reports ask for a reason and respect the 366-day limit; CSV has no blood group
//   doctor patients: blood group appears only for patients under treatment
// Usage: WEB_URL=http://localhost:8089 node tests/privacy-ui.cjs
const { chromium } = require('playwright');
const fs = require('fs');

const B = process.env.WEB_URL || 'http://localhost:5173';
const results = []; let failed = 0;
const check = (name, ok, extra = '') => { results.push(`  ${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${extra}`}`); if (!ok) failed += 1; };

async function api(method, p, token, body, reason) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(reason ? { 'X-Access-Reason': encodeURIComponent(reason) } : {}) };
  const res = await fetch(`${B}/api${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}
async function login(browser, email, pw) {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p = await c.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  await p.goto(`${B}/login`, { waitUntil: 'networkidle' });
  await p.fill('input[type=email]', email); await p.fill('input[type=password]', pw);
  await p.click('button[type=submit]');
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
  return p;
}
const toast = async (p, type) => { const t = p.locator(`.toast.is-${type}`).last(); await t.waitFor({ timeout: 8000 }); const s = await t.textContent(); await p.evaluate(() => document.querySelectorAll('.toast').forEach((x) => x.remove())); return s; };
const askReason = async (p, text) => { await p.locator('#confirm-dialog [data-confirm-reason] textarea').fill(text); await p.click('#confirm-dialog [data-confirm-ok]'); };

(async () => {
  const adminToken = (await api('POST', '/auth/login', null, { email: 'admin@medicore.com', password: 'Admin@123' })).token;
  const docToken = (await api('POST', '/auth/login', null, { email: 'david.chen@medicore.com', password: 'Doctor@123' })).token;
  const browser = await chromium.launch();
  const adm = await login(browser, 'admin@medicore.com', 'Admin@123');

  // ── Admin patient list ──
  await adm.goto(`${B}/admin/patients`, { waitUntil: 'networkidle' });
  await adm.waitForSelector('#list[data-state=ready]');
  const listText = await adm.locator('#list').innerText();
  check('admin list: no Blood column and no allergy count text', !/\bBlood\b/.test(listText) && !/allerg/i.test(listText));
  check('admin list: identity, contact and activity data are still shown', /appts/.test(listText) && /@/.test(listText));

  // ── Registration with blood group, through the form ──
  const stamp = Date.now();
  const email = `priv.ui.${stamp}@example.com`;
  await adm.click('#add');
  const dlg = adm.locator('#patient-dialog');
  await dlg.locator('[name=fullName]').fill('Privacy UiRegistered');
  await dlg.locator('[name=email]').fill(email);
  await dlg.locator('[name=password]').fill('Temp@1234');
  await dlg.locator('[name=phone]').fill('+1 555 0177');
  await dlg.locator('[name=dateOfBirth]').fill('1988-03-09');
  await dlg.locator('[name=gender]').selectOption('MALE');
  await dlg.locator('[name=bloodGroup]').selectOption('AB_NEG');
  await dlg.locator('[name=address]').fill('99 Privacy Road');
  await dlg.locator('[type=submit]').click();
  check('registration: succeeds with a blood group', /registered/i.test(await toast(adm, 'success')));
  const created = (await api('GET', `/admin/patients?search=${encodeURIComponent(email)}`, adminToken)).data.items[0];
  const detail = (await api('GET', `/admin/patients/${created.id}`, adminToken, null, 'Checking the UI registration')).data;
  check('registration: blood group was stored (visible only through the reason-gated detail)', detail.bloodGroup === 'AB_NEG' && !('bloodGroup' in created));

  // ── Edit: change one field, everything else must survive ──
  await adm.fill('#filters input[name=search]', email);
  await adm.waitForTimeout(900);
  await adm.locator('#list tbody tr', { hasText: 'Privacy UiRegistered' }).first().locator('[data-open=patient-dialog]').click();
  check('edit form: blood group is not offered (registration only)', !(await dlg.locator('[name=bloodGroup]').isVisible()));
  const prefilled = await dlg.locator('[name=address]').inputValue();
  check('edit form: stored values are pre-filled', prefilled === '99 Privacy Road' && (await dlg.locator('[name=phone]').inputValue()) === '+1 555 0177');
  await dlg.locator('[name=phone]').fill('+1 555 0188');
  await dlg.locator('[type=submit]').click();
  check('edit: saves', /updated/i.test(await toast(adm, 'success')));
  const after = (await api('GET', `/admin/patients/${created.id}`, adminToken, null, 'Checking the UI edit')).data;
  check('edit: only the phone changed — address, gender, birth date and blood group are intact', after.phone === '+1 555 0188' && after.address === '99 Privacy Road' && after.gender === 'MALE' && after.dateOfBirth.slice(0, 10) === '1988-03-09' && after.bloodGroup === 'AB_NEG' && after.fullName === 'Privacy UiRegistered');
  // clearing a field in the form is not sent: it does not erase the stored value
  await adm.locator('#list tbody tr', { hasText: 'Privacy UiRegistered' }).first().locator('[data-open=patient-dialog]').click();
  await dlg.locator('[name=address]').fill('');
  await dlg.locator('[type=submit]').click();
  await toast(adm, 'success');
  const kept = (await api('GET', `/admin/patients/${created.id}`, adminToken, null, 'Checking the UI edit')).data;
  check('edit: a field emptied in the form does not erase the stored value', kept.address === '99 Privacy Road');

  // ── Reports ──
  await adm.goto(`${B}/admin/reports`, { waitUntil: 'networkidle' });
  await adm.locator('#types label', { hasText: 'Patient registrations' }).click();
  await adm.click('#generate');
  await adm.locator('#confirm-dialog [data-confirm-reason]').waitFor();
  check('reports: a patient-identifying report asks for a reason', /why do you need this report/i.test(await adm.locator('#confirm-dialog').innerText()));
  await askReason(adm, 'too short');
  check('reports: a too-short reason is refused in the UI', /at least 10 characters/.test(await toast(adm, 'error')));
  await adm.click('#generate');
  await askReason(adm, 'Quarterly registration review');
  await adm.locator('#result[data-state=ready]').waitFor({ timeout: 8000 });
  const table = await adm.locator('#result').innerText();
  check('reports: the table has no blood group column', !/blood/i.test(table) && /registered/i.test(table) && /email/i.test(table));
  // CSV download
  const [download] = await Promise.all([adm.waitForEvent('download'), (async () => { await adm.click('#export'); await adm.locator('#confirm-dialog [data-confirm-reason]').waitFor(); await askReason(adm, 'Archive copy for the registration review'); })()]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  check('reports: the CSV download works and has no blood group', /^Registered,Name,Email,Gender,Appointments,Emergencies/.test(csv) && !/blood/i.test(csv.split('\n')[0]));
  // aggregate report: no prompt
  await adm.locator('#types label', { hasText: 'Doctor performance' }).click();
  await adm.click('#generate');
  await adm.locator('#result[data-state=ready]').waitFor({ timeout: 8000 });
  check('reports: aggregate reports (no patient names) need no reason', !(await adm.locator('#confirm-dialog').isVisible()));
  // 366-day limit
  await adm.locator('#types label', { hasText: 'Patient registrations' }).click();
  const from = adm.locator('[data-range] [name=from]');
  await from.evaluate((el) => { el.removeAttribute('min'); el.value = new Date(Date.now() - 800 * 86400000).toISOString().slice(0, 10); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await adm.click('#generate');
  await askReason(adm, 'Checking the date range limit');
  const limitMsg = await toast(adm, 'error');
  check('reports: a range over 366 days shows a clear error', /366 days/.test(limitMsg), limitMsg);

  // ── Doctor patient list ──
  const mine = (await api('GET', '/doctor/patients?limit=100', docToken)).data.items;
  const sample = await Promise.all(mine.map(async (p) => ({ p, level: (await api('GET', `/doctor/patients/${p.id}`, docToken)).data?.access?.level })));
  const hist = sample.find((x) => x.level === 'HISTORICAL'); const treat = sample.find((x) => x.level === 'TREATMENT');
  const doc = await login(browser, 'david.chen@medicore.com', 'Doctor@123');
  await doc.goto(`${B}/doctor/patients`, { waitUntil: 'networkidle' });
  await doc.waitForSelector('#patients[data-state=ready]');
  if (hist) {
    const card = doc.locator('#patients a', { hasText: hist.p.fullName }).first();
    check('doctor list: a history-only patient shows no blood group or allergy badge', !/\b(A|B|AB|O)[+−]/.test(await card.innerText()) && !/allerg/i.test(await card.innerText()));
  }
  if (treat) {
    const row = mine.find((p) => p.id === treat.p.id);
    check('doctor list: patients under treatment keep their blood group', !row.bloodGroup || /\b(A|B|AB|O)[+−]/.test(await doc.locator('#patients a', { hasText: treat.p.fullName }).first().innerText()));
  } else results.push('  ○ no patient under treatment for this doctor (skipped)');

  for (const [n, p] of [['admin', adm], ['doctor', doc]]) check(`no console/page errors (${n})`, !p.errors.length, p.errors.join(' | '));
  await browser.close();
  console.log(results.join('\n'));
  console.log(failed ? `\nFAILED (${failed})` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
