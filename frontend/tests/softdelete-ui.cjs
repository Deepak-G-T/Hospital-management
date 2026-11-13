/* eslint-disable no-console */
// Soft deletion through the real UI (needs a freshly seeded *test* database and API).
//   patient: removes an allergy / report → "Recently deleted" → restores
//   doctor:  treating doctor still sees the removed allergy, flagged
//   admin:   deletes a doctor and a department → hidden → "Deleted" filter → restores
// Usage: WEB_URL=http://localhost:8089 node tests/softdelete-ui.cjs
const { chromium } = require('playwright');

const B = process.env.WEB_URL || 'http://localhost:5173';
const results = []; let failed = 0;
const check = (name, ok, extra = '') => { results.push(`  ${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${extra}`}`); if (!ok) failed += 1; };
async function api(method, p, token, body, form) {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const res = await fetch(`${B}/api${p}`, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
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
const toast = async (p, type = 'success') => { const t = p.locator(`.toast.is-${type}`).last(); await t.waitFor({ timeout: 8000 }); const s = await t.textContent(); await p.evaluate(() => document.querySelectorAll('.toast').forEach((x) => x.remove())); return s; };
const confirm = (p) => p.click('#confirm-dialog [data-confirm-ok]');

(async () => {
  const adminToken = (await api('POST', '/auth/login', null, { email: 'admin@medicore.com', password: 'Admin@123' })).token;
  const docToken = (await api('POST', '/auth/login', null, { email: 'david.chen@medicore.com', password: 'Doctor@123' })).token;
  const browser = await chromium.launch();

  // a patient David Chen is treating now (found through his own patient list, then logged in with the seed password)
  let target;
  for (const p of (await api('GET', '/doctor/patients?limit=100', docToken)).data.items) {
    const c = (await api('GET', `/doctor/patients/${p.id}`, docToken)).data;
    if (c?.access.level === 'TREATMENT') { target = { id: p.id, email: c.user.email, name: p.fullName }; break; }
  }
  if (!target) { console.log('Skipped: no treated patient in this data set'); process.exit(0); }
  const patientToken = (await api('POST', '/auth/login', null, { email: target.email, password: 'Patient@123' })).token;
  const marker = `Latex-${Date.now()}`;
  await api('POST', '/patient/allergies', patientToken, { allergen: marker, type: 'ENVIRONMENTAL', severity: 'MODERATE' });
  const form = new FormData(); form.append('title', `Report-${marker}`); form.append('reportType', 'LAB'); form.append('file', new Blob(['%PDF-1.4\n%ui test\n'], { type: 'application/pdf' }), 'ui.pdf');
  const up = await api('POST', '/patient/reports', patientToken, null, form);

  // ── Patient ──
  const pat = await login(browser, target.email, 'Patient@123');
  await pat.goto(`${B}/patient/medical-profile`, { waitUntil: 'networkidle' });
  await pat.locator('li', { hasText: marker }).first().waitFor();
  await pat.locator('li', { hasText: marker }).first().locator('[data-call^="DELETE"]').click();
  check('patient: the removal confirmation says the entry is kept and restorable', /restore it later/.test(await pat.locator('#confirm-dialog').innerText()));
  await confirm(pat); await toast(pat);
  await pat.waitForTimeout(800);
  check('patient: the allergy leaves the active list and appears under "Recently deleted"', await pat.locator('#deleted-allergies li', { hasText: marker }).count() === 1 && await pat.locator('#allergies li, [data-source="/patient/allergies"]:not(#deleted-allergies) li', { hasText: marker }).count() === 0);
  const docChart = (await api('GET', `/doctor/patients/${target.id}`, docToken)).data;
  check('API: the treating doctor still receives it, flagged', docChart.allergies.some((a) => a.allergen === marker && a.deletedAt));
  const doc = await login(browser, 'david.chen@medicore.com', 'Doctor@123');
  await doc.goto(`${B}/doctor/patients/${target.id}`, { waitUntil: 'networkidle' });
  await doc.waitForSelector('#record[data-state=ready]');
  check('doctor: the chart shows the removed allergy marked "removed by patient"', /removed by patient/.test(await doc.locator('#record').innerText()) && (await doc.locator('#record').innerText()).includes(marker));
  await pat.locator('#deleted-allergies li', { hasText: marker }).locator('button', { hasText: 'Restore' }).click();
  check('patient: restore works', /restored/i.test(await toast(pat)));
  await pat.waitForTimeout(800);
  check('patient: the allergy is back in the active list', await pat.locator('#deleted-allergies li', { hasText: marker }).count() === 0 && (await pat.locator('body').innerText()).includes(marker));

  await pat.goto(`${B}/patient/reports`, { waitUntil: 'networkidle' });
  await pat.locator('#reports article', { hasText: `Report-${marker}` }).first().locator('[data-call^="DELETE"]').click();
  await confirm(pat); await toast(pat);
  await pat.waitForTimeout(800);
  check('patient: a deleted report moves to "Recently deleted" and can be restored', await pat.locator('#deleted-reports li', { hasText: `Report-${marker}` }).count() === 1);
  check('API: the deleted report cannot be downloaded by the patient but the treating doctor still can',
    (await fetch(`${B}/api/files/reports/${up.data.id}`, { headers: { Authorization: `Bearer ${patientToken}` } })).status === 404 && (await fetch(`${B}/api/files/reports/${up.data.id}`, { headers: { Authorization: `Bearer ${docToken}` } })).status === 200);
  await pat.locator('#deleted-reports li', { hasText: `Report-${marker}` }).locator('button', { hasText: 'Restore' }).click();
  await toast(pat);
  await pat.waitForTimeout(800);
  check('patient: the report is restored', await pat.locator('#deleted-reports li', { hasText: `Report-${marker}` }).count() === 0);

  // ── Admin: doctor ──
  const stamp = Date.now();
  const d = (await api('POST', '/admin/doctors', adminToken, { email: `sd.ui.${stamp}@medicore.com`, password: 'Doctor@123', fullName: `SoftUi Doctor ${stamp}`, specialization: 'UI Medicine', licenseNumber: `SDUI-${stamp}`, consultationFee: 10, experienceYears: 1, departmentIds: [], primaryDepartmentId: null })).data;
  const adm = await login(browser, 'admin@medicore.com', 'Admin@123');
  await adm.goto(`${B}/admin/doctors`, { waitUntil: 'networkidle' });
  await adm.fill('#filters input[name=search]', `SoftUi Doctor ${stamp}`);
  await adm.waitForTimeout(900);
  const row = adm.locator('#list tbody tr', { hasText: `SoftUi Doctor ${stamp}` }).first();
  await row.locator('[data-call^="DELETE"]').click();
  check('admin: the delete confirmation says history is kept and restorable', /restore the doctor later/.test(await adm.locator('#confirm-dialog').innerText()));
  await confirm(adm); check('admin: doctor deleted', /deleted/i.test(await toast(adm)));
  await adm.waitForTimeout(900);
  check('admin: the doctor disappears from the default list', await adm.locator('#list tbody tr', { hasText: `SoftUi Doctor ${stamp}` }).count() === 0);
  await adm.selectOption('#filters select[name=status]', 'deleted'); await adm.waitForTimeout(900);
  const delRow = adm.locator('#list tbody tr', { hasText: `SoftUi Doctor ${stamp}` }).first();
  check('admin: under "Deleted" only Restore is offered', await delRow.locator('button', { hasText: 'Restore' }).isVisible() && !(await delRow.locator('[data-call^="DELETE"]').isVisible()));
  await delRow.locator('button', { hasText: 'Restore' }).click(); check('admin: doctor restored', /restored/i.test(await toast(adm)));
  await adm.selectOption('#filters select[name=status]', 'active'); await adm.waitForTimeout(900);
  check('admin: the restored doctor is active again', await adm.locator('#list tbody tr', { hasText: `SoftUi Doctor ${stamp}` }).count() === 1);

  // ── Admin: department ──
  const dep = (await api('POST', '/admin/departments', adminToken, { name: `SoftUi Dept ${stamp}`, description: 'x', keywords: 'softui', icon: 'Stethoscope' })).data;
  await adm.goto(`${B}/admin/departments`, { waitUntil: 'networkidle' });
  const card = adm.locator('#list article', { hasText: `SoftUi Dept ${stamp}` }).first();
  await card.locator('[data-call^="DELETE"]').click(); await confirm(adm); await toast(adm); await adm.waitForTimeout(900);
  check('admin: a deleted department leaves the list', await adm.locator('#list article', { hasText: `SoftUi Dept ${stamp}` }).count() === 0);
  await adm.selectOption('#dfilter', 'true'); await adm.waitForTimeout(900);
  await adm.locator('#list article', { hasText: `SoftUi Dept ${stamp}` }).first().locator('button', { hasText: 'Restore' }).click(); await toast(adm);
  await adm.selectOption('#dfilter', ''); await adm.waitForTimeout(900);
  check('admin: the restored department is back', await adm.locator('#list article', { hasText: `SoftUi Dept ${stamp}` }).count() === 1);
  check('API: nothing was removed (doctor and department rows still readable)', (await api('GET', `/admin/doctors/${d.id}`, adminToken)).success !== false && dep.id);

  for (const [n, p] of [['patient', pat], ['doctor', doc], ['admin', adm]]) check(`no console/page errors (${n})`, !p.errors.length, p.errors.join(' | '));
  await browser.close();
  console.log(results.join('\n'));
  console.log(failed ? `\nFAILED (${failed})` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
