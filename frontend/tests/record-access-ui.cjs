/* eslint-disable no-console */
// Access to medical information through the real UI (P1 item 7). Needs a freshly seeded *test* database and API.
//   doctor: a past patient shows the "limited view" notice, hides allergies and the write buttons
//   admin:  patient dialog and emergency dialog withhold clinical details until a reason is given; a too-short reason is
//           refused; a valid reason opens them and is written to the audit log
// Usage: WEB_URL=http://localhost:8089 node tests/record-access-ui.cjs
const { chromium } = require('playwright');

const B = process.env.WEB_URL || 'http://localhost:5173';
const results = []; let failed = 0;
const check = (name, ok, extra = '') => { results.push(`  ${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${extra}`}`); if (!ok) failed += 1; };

async function api(method, p, token, body, reason) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(reason ? { 'X-Access-Reason': encodeURIComponent(reason) } : {}) };
  const res = await fetch(`${B}/api${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}
async function login(browser, email, pw) {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
const toast = async (p, type) => { const t = p.locator(`.toast.is-${type}`).last(); await t.waitFor({ timeout: 6000 }); const s = await t.textContent(); await p.evaluate(() => document.querySelectorAll('.toast').forEach((x) => x.remove())); return s; };

(async () => {
  const adminToken = (await api('POST', '/auth/login', null, { email: 'admin@medicore.com', password: 'Admin@123' })).token;
  const docToken = (await api('POST', '/auth/login', null, { email: 'david.chen@medicore.com', password: 'Doctor@123' })).token;
  const browser = await chromium.launch();

  // ── Doctor: a patient seen only in the past ──
  const mine = (await api('GET', '/doctor/patients?limit=100', docToken)).data.items;
  let past = null;
  for (const p of mine) { const r = (await api('GET', `/doctor/patients/${p.id}`, docToken)).data; if (r?.access.level === 'HISTORICAL') { past = r; break; } }
  if (!past) { console.log('Skipped: no historical patient for this doctor in the data'); process.exit(0); }
  const doc = await login(browser, 'david.chen@medicore.com', 'Doctor@123');
  await doc.goto(`${B}/doctor/patients/${past.id}`, { waitUntil: 'networkidle' });
  await doc.waitForSelector('#record[data-state=ready]');
  const text = await doc.locator('#record').innerText();
  check('doctor: limited-view notice explains why the chart is reduced', /Limited view/.test(text) && /only the records from your own consultations/.test(text));
  check('doctor: Prescribe / Diagnosis / Upload / Refer buttons are hidden without an active relationship', !(await doc.locator('#record [data-action=rx]').isVisible()) && !(await doc.locator('#record button:has-text("Refer")').isVisible()));
  check('doctor: allergies are not shown on a historical view', !(await doc.locator('#record .notice-danger').isVisible()));
  const active = (await Promise.all(mine.map(async (p) => (await api('GET', `/doctor/patients/${p.id}`, docToken)).data))).find((r) => r?.access.level === 'TREATMENT');
  if (active) {
    await doc.goto(`${B}/doctor/patients/${active.id}`, { waitUntil: 'networkidle' });
    await doc.waitForSelector('#record[data-state=ready]');
    check('doctor: an active patient shows the action buttons and no limited-view notice', await doc.locator('#record [data-action=rx]').isVisible() && !/Limited view/.test(await doc.locator('#record').innerText()));
  } else results.push('  ○ no patient with an active relationship in this data set (skipped)');

  // ── Admin: patient dialog ──
  // the admin list no longer shows allergy counts, so create a patient who has an allergy
  const apEmail = `acc.ui.allergy.${Date.now()}@example.com`;
  const ap = await api('POST', '/auth/register', null, { email: apEmail, password: 'Start@1234', fullName: 'Allergy UiPatient' });
  await api('POST', '/patient/allergies', ap.token, { allergen: 'Latex', type: 'ENVIRONMENTAL', severity: 'MODERATE' });
  const withAllergy = (await api('GET', '/admin/patients?search=Allergy%20UiPatient', adminToken)).data.items[0];
  const adm = await login(browser, 'admin@medicore.com', 'Admin@123');
  await adm.goto(`${B}/admin/patients`, { waitUntil: 'networkidle' });
  await adm.fill('#filters input[name=search]', withAllergy.fullName);
  await adm.waitForTimeout(900);
  await adm.locator('#list tbody tr', { hasText: withAllergy.fullName }).first().locator('[data-open=view-dialog]').click();
  const pdlg = adm.locator('#view-dialog');
  await pdlg.locator('text=Allergies and medical history are confidential').waitFor({ timeout: 5000 });
  check('admin: patient dialog shows registration data but withholds allergies and history', await pdlg.locator('button:has-text("Open medical details")').isVisible() && !/None recorded/.test(await pdlg.innerText()));
  await pdlg.locator('button:has-text("Open medical details")').click();
  await adm.locator('#confirm-dialog [data-confirm-reason] textarea').fill('too short');
  await adm.click('#confirm-dialog [data-confirm-ok]');
  check('admin: a reason shorter than 10 characters is refused in the UI', /at least 10 characters/.test(await toast(adm, 'error')));
  const t0 = new Date();
  await pdlg.locator('button:has-text("Open medical details")').click();
  await adm.locator('#confirm-dialog [data-confirm-reason] textarea').fill('Checking allergy list after patient complaint');
  await adm.click('#confirm-dialog [data-confirm-ok]');
  await pdlg.locator('text=Allergies').first().waitFor();
  await adm.waitForTimeout(600);
  const opened = await pdlg.innerText();
  check('admin: with a valid reason the allergies are shown and the prompt disappears', /\bAllergies\b/.test(opened) && !/are confidential/.test(opened));
  const logs = (await api('GET', `/admin/audit-logs?action=MEDICAL_ACCESS_EXCEPTIONAL&limit=20`, adminToken)).data?.items || [];
  const mineLog = logs.find((l) => new Date(l.createdAt) >= t0 && l.details?.patientId === withAllergy.id);
  check('admin: the access is in the audit log with the reason typed in the UI', mineLog && mineLog.details.reason === 'Checking allergy list after patient complaint' && mineLog.details.resource === 'ADMIN_PATIENT_RECORD', JSON.stringify(mineLog?.details));

  // ── Admin: emergency dialog (an active emergency with an allergy) ──
  const email = `acc.ui.${Date.now()}@example.com`;
  const reg = await api('POST', '/auth/register', null, { email, password: 'Start@1234', fullName: 'Access UiTest' });
  await api('POST', '/patient/allergies', reg.token, { allergen: 'Penicillin', type: 'DRUG', severity: 'SEVERE' });
  const dept = (await api('GET', '/public/departments')).data.find((d) => d.name === 'Cardiology');
  await api('POST', '/patient/emergencies', reg.token, { priority: 'LOW', departmentId: dept.id, symptoms: 'Synthetic UI test — palpitations' });
  await adm.goto(`${B}/admin/emergencies`, { waitUntil: 'networkidle' });
  await adm.locator('#list button', { hasText: 'Access UiTest' }).first().click();
  const edlg = adm.locator('#em-dialog');
  await edlg.locator('button:has-text("Open medical details")').waitFor({ timeout: 5000 });
  check('admin: emergency dialog withholds allergies by default', !/Penicillin/.test(await edlg.innerText()));
  await edlg.locator('button:has-text("Open medical details")').click();
  await adm.locator('#confirm-dialog [data-confirm-reason] textarea').fill('Coordinating emergency transfer for this patient');
  await adm.click('#confirm-dialog [data-confirm-ok]');
  await edlg.locator('text=Penicillin').first().waitFor({ timeout: 6000 });
  check('admin: with a reason the emergency dialog shows the allergy', /Penicillin/.test(await edlg.innerText()));
  await adm.waitForTimeout(500);
  await api('POST', `/patient/emergencies/${(await api('GET', '/patient/emergencies', reg.token)).data[0].id}/cancel`, reg.token);

  for (const [n, p] of [['doctor', doc], ['admin', adm]]) check(`no console/page errors (${n})`, !p.errors.length, p.errors.join(' | '));
  await browser.close();
  console.log(results.join('\n'));
  console.log(failed ? `\nFAILED (${failed})` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
