// Clicks through the create/edit/delete/submit actions of every portal and checks the outcome (99 checks).
// Needs the API and the website running on a freshly seeded *test* database.
//   WEB_URL=http://localhost:8089 node tests/actions.cjs      (optional ONLY=admin|doctor|patient|public)
// Independent of the time of day: the emergency section makes its doctor "on shift" through the doctor's own schedule endpoint.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = process.env.WEB_URL || 'http://localhost:5173';
const ONLY = process.env.ONLY || '';
const results = [];
let failed = 0;
const check = (name, ok, extra = '') => { results.push(`  ${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${extra}`}`); if (!ok) failed += 1; };
const PDF = path.join(os.tmpdir(), 'medicore-qa-report.pdf');
fs.writeFileSync(PDF, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

const api = async (method, url, token, body) => {
  const r = await fetch(`${B}${url}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
};
const sessionToken = async (email, pw) => (await api('POST', '/api/auth/login', null, { email, password: pw })).json.data.token;
const slotsOf = (list) => list.map(({ dayOfWeek, startTime, endTime }) => ({ dayOfWeek, startTime, endTime }));
// Emergency alerts go to doctors who are on shift *now* (server clock) before anyone else, so the result of the emergency steps would
// depend on the hour and weekday the suite runs at. This fixture makes the test doctor on shift all week via the doctor's own
// schedule endpoint (any time except the last minute of a day, when nobody is on shift and everyone in the department is alerted
// anyway) and returns a function that puts the original schedule back. The emergency itself stays HIGH, as a real patient would send.
async function putDoctorOnShiftAllWeek(email, pw) {
  const token = await sessionToken(email, pw);
  const before = slotsOf((await api('GET', '/api/doctor/availability', token)).json.data);
  const allWeek = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startTime: '00:00', endTime: '23:59' }));
  const set = await api('PUT', '/api/doctor/availability', token, { slots: allWeek });
  if (!set.ok) throw new Error(`test setup failed: could not set the doctor's schedule (${set.status})`);
  return async () => { const back = await api('PUT', '/api/doctor/availability', token, { slots: before }); if (!back.ok) throw new Error(`test setup failed: could not restore the schedule (${back.status})`); };
}

async function login(browser, email, pw) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  if (email) {
    await p.goto(`${B}/login`, { waitUntil: 'networkidle' });
    await p.fill('input[name=email]', email); await p.fill('input[name=password]', pw);
    await p.click('button[type=submit]'); await p.waitForURL((u) => !u.pathname.startsWith('/login'));
  }
  return p;
}
const go = async (p, url) => { await p.goto(`${B}${url}`, { waitUntil: 'networkidle' }); await p.waitForTimeout(400); };
const dlg = (p) => p.locator('dialog[open]');
// waits for a toast; returns its text. type: success|error
async function toastText(p, type = 'success') {
  const t = p.locator(`.toast.is-${type}`).last();
  try { await t.waitFor({ timeout: 6000 }); } catch { const e = await p.locator('.toast.is-error').last().textContent().catch(() => ''); return `NO ${type} TOAST ${e ? `(error: ${e})` : ''}`; }
  const s = await t.textContent();
  await p.evaluate(() => document.querySelectorAll('.toast').forEach((x) => x.remove()));
  return s;
}
async function step(name, p, fn, expect) {
  try {
    const r = await fn();
    const ok = expect instanceof RegExp ? expect.test(r || '') : expect ? await expect(r) : true;
    check(name, ok, `→ ${String(r).slice(0, 160)}`);
  } catch (e) { check(name, false, `threw: ${e.message.split('\n')[0].slice(0, 200)}`); }
}
const confirmOk = (p) => p.click('#confirm-dialog [data-confirm-ok]');
const submitDialog = (p) => dlg(p).locator('[type=submit]').click();
const row = (p, text) => p.locator('tr, li, article, .card', { hasText: text }).last();
const listHas = async (p, sel, text) => { await p.waitForTimeout(700); return (await p.locator(sel, { hasText: text }).count()) > 0; };

(async () => {
  const browser = await chromium.launch();
  const stamp = Date.now().toString().slice(-6);

  if (!ONLY || ONLY === 'admin') {
    const p = await login(browser, 'admin@medicore.com', 'Admin@123');
    // Departments
    await go(p, '/admin/departments');
    const dn = `QA Dept ${stamp}`;
    await step('admin: create department', p, async () => { await p.click('text=New department'); await dlg(p).locator('[name=name]').fill(dn); await submitDialog(p); return toastText(p); }, /created/i);
    check('admin: new department listed', await listHas(p, '#list', dn));
    await step('admin: edit department', p, async () => { await row(p, dn).getByRole('button', { name: 'Edit' }).click(); check('admin: edit form prefilled', (await dlg(p).locator('[name=name]').inputValue()) === dn); await dlg(p).locator('[name=location]').fill('Block Q'); await submitDialog(p); return toastText(p); }, /updated/i);
    check('admin: edited department shows location', await listHas(p, '#list', 'Block Q'));
    await step('admin: delete department', p, async () => { await row(p, dn).getByRole('button', { name: 'Delete department' }).click(); await confirmOk(p); return toastText(p); }, /./);
    check('admin: department removed', !(await listHas(p, '#list', dn)));

    // Doctors
    await go(p, '/admin/doctors');
    const docName = `QA Doctor ${stamp}`;
    await step('admin: add doctor', p, async () => {
      await p.click('#add'); const d = dlg(p);
      await d.locator('[name=fullName]').fill(docName); await d.locator('[name=email]').fill(`qa.doc${stamp}@example.com`);
      await d.locator('[name=password]').fill('Doctor@123'); await d.locator('[name=specialization]').fill('Cardiology');
      await d.locator('[name=licenseNumber]').fill(`LIC-QA-${stamp}`); await d.locator('[name="departmentIds[]"]').first().check();
      await submitDialog(p); return toastText(p);
    }, /added/i);
    await p.fill('#filters [name=search]', docName); await p.waitForTimeout(900);
    check('admin: doctor found by search', await listHas(p, '#list', docName));
    await step('admin: edit doctor', p, async () => { await row(p, docName).getByRole('button', { name: 'Edit' }).click(); check('admin: doctor form prefilled', (await dlg(p).locator('[name=licenseNumber]').inputValue()) === `LIC-QA-${stamp}`); await dlg(p).locator('[name=phone]').fill('+1 555 0101'); await submitDialog(p); return toastText(p); }, /updated/i);
    await step('admin: assign departments', p, async () => { await row(p, docName).getByRole('button', { name: 'Assign departments' }).click(); await dlg(p).locator('[name="departmentIds[]"]').nth(1).check(); await submitDialog(p); return toastText(p); }, /assigned/i);
    await step('admin: view doctor', p, async () => { await row(p, docName).locator('.cell-person').click(); const t = await dlg(p).textContent(); await dlg(p).locator('[data-close]').first().click(); return t; }, new RegExp(`LIC-QA-${stamp}`));
    await step('admin: deactivate doctor', p, async () => { await row(p, docName).getByRole('button', { name: /Deactivate/ }).click(); return toastText(p); }, /deactivated/i);
    await step('admin: delete doctor', p, async () => { await row(p, docName).getByRole('button', { name: 'Delete' }).click(); await confirmOk(p); return toastText(p); }, /./);

    // Patients
    await go(p, '/admin/patients');
    const pn = `QA Patient ${stamp}`;
    await step('admin: register patient', p, async () => { await p.click('#add'); const d = dlg(p); await d.locator('[name=fullName]').fill(pn); await d.locator('[name=email]').fill(`qa.pat${stamp}@example.com`); await d.locator('[name=password]').fill('Patient@123'); await submitDialog(p); return toastText(p); }, /registered/i);
    await p.fill('#filters [name=search]', pn); await p.waitForTimeout(900);
    await step('admin: view patient', p, async () => { await row(p, pn).getByRole('button', { name: 'View' }).click(); await p.waitForTimeout(800); const t = await dlg(p).textContent(); await dlg(p).locator('[data-close]').first().click(); return t; }, new RegExp(`qa.pat${stamp}`));
    await step('admin: edit patient', p, async () => { await row(p, pn).getByRole('button', { name: 'Edit' }).click(); check('admin: patient form prefilled', (await dlg(p).locator('[name=fullName]').inputValue()) === pn); await dlg(p).locator('[name=address]').fill('1 QA Street'); await submitDialog(p); return toastText(p); }, /updated/i);
    await step('admin: deactivate patient', p, async () => { await row(p, pn).getByRole('button', { name: /Deactivate/ }).click(); return toastText(p); }, /deactivated/i);

    // Users
    await go(p, '/admin/users');
    await p.fill('#filters [name=search]', `qa.pat${stamp}`); await p.waitForTimeout(900);
    await step('admin: reset password', p, async () => { await row(p, `qa.pat${stamp}`).getByRole('button', { name: /Reset/ }).click(); await dlg(p).locator('[name=newPassword]').fill('NewPass@123'); await submitDialog(p); return toastText(p); }, /reset/i);
    await step('admin: activate user', p, async () => { await row(p, `qa.pat${stamp}`).getByRole('button', { name: /Activate/ }).click(); return toastText(p); }, /activated/i);
    await p.selectOption('#filters [name=role]', 'DOCTOR'); await p.fill('#filters [name=search]', ''); await p.waitForTimeout(900);
    check('admin: users role filter', (await p.locator('#list [data-list] > *').count()) > 0 && !(await listHas(p, '#list [data-list]', 'Patient')));

    // Appointments
    await go(p, '/admin/appointments?status=PENDING');
    check('admin: status filter from URL', (await p.inputValue('#filters [name=status]')) === 'PENDING');
    await step('admin: approve appointment', p, async () => { await p.locator('#list [data-list] > *').first().getByRole('button', { name: /Approve/ }).click(); await confirmOk(p); return toastText(p); }, /confirmed/i);

    // Complaints
    await go(p, '/admin/complaints');
    await step('admin: respond to complaint', p, async () => { await p.locator('#list [data-list] > *').first().getByRole('button', { name: /Respond|Update/ }).click(); await dlg(p).locator('textarea').fill('QA response'); await submitDialog(p); return toastText(p); }, /response/i);

    // Notifications
    await go(p, '/admin/notifications');
    await step('admin: send broadcast', p, async () => { await p.fill('#broadcast-form [name=title]', `QA broadcast ${stamp}`); await p.fill('#broadcast-form [name=message]', 'Testing'); await p.click('#broadcast-form [type=submit]'); return toastText(p); }, /Sent to \d+/);
    check('admin: broadcast listed', await listHas(p, '#sent', `QA broadcast ${stamp}`));
    await step('admin: recall broadcast', p, async () => { await p.locator('#sent li', { hasText: `QA broadcast ${stamp}` }).getByRole('button', { name: /Recall/ }).click(); await confirmOk(p); return toastText(p); }, /./);

    // Audit logs + reports + emergencies
    await go(p, '/admin/audit-logs');
    const actions = await p.locator('#filters [name=action] option').count();
    check('admin: audit actions loaded', actions > 3, `${actions} options`);
    await p.selectOption('#filters [name=action]', 'LOGIN'); await p.waitForTimeout(900);
    check('admin: audit filter by action', (await p.locator('#list [data-list] tr').count()) > 0 && (await p.locator('#list [data-list] tr', { hasText: 'PATIENT_RECORD_VIEWED' }).count()) === 0);
    await go(p, '/admin/reports');
    await step('admin: generate report', p, async () => { await p.click('#generate'); await p.locator('#confirm-dialog [data-confirm-reason] textarea').fill('QA appointment register review'); await p.click('#confirm-dialog [data-confirm-ok]'); await p.waitForTimeout(1200); return p.locator('#result').getAttribute('data-state'); }, /ready/);
    await go(p, '/admin/emergencies');
    await step('admin: emergency detail update', p, async () => { await p.click('#status [data-value=""]'); await p.waitForTimeout(800); await p.locator('#list [data-list] > *').first().click(); await p.waitForTimeout(300); const d = dlg(p); await d.locator('[name=priority]').selectOption('LOW'); await d.locator('#admin-form [type=submit]').click(); return toastText(p); }, /updated/i);
    check('admin: emergency dialog shows new priority', /Low/.test(await dlg(p).locator('[data-priority-of]').first().textContent()));
    await step('admin: re-alert doctors', p, async () => { await dlg(p).getByRole('button', { name: /Re-alert/ }).click(); return toastText(p); }, /alerted/i);
    await step('admin: resolve emergency', p, async () => { await dlg(p).locator('[name=notes]').fill('QA resolved'); await dlg(p).getByRole('button', { name: /Mark resolved/ }).click(); return toastText(p); }, /resolved/i);
    check('admin: no page errors', p.errors.length === 0, p.errors.join(' | ').slice(0, 300));
    await p.context().close();
  }

  if (!ONLY || ONLY === 'doctor') {
    const p = await login(browser, 'david.chen@medicore.com', 'Doctor@123');
    await go(p, '/doctor/appointments');
    await step('doctor: accept request', p, async () => { await p.click('#scope [data-value=all]').catch(() => {}); await p.selectOption('#status', 'PENDING'); await p.waitForTimeout(900); await p.locator('#appts [data-list] > *').first().locator('button[title="Accept"]').click(); await confirmOk(p); return toastText(p); }, /confirmed/i);
    await p.fill('#search', 'zzzz-nobody'); await p.waitForTimeout(900);
    check('doctor: appointment search empties list', (await p.getAttribute('#appts', 'data-state')) === 'empty');
    await go(p, '/doctor/messages');
    await step('doctor: send department message', p, async () => { await p.click('#new-msg'); const d = dlg(p); await d.locator('[name=toDepartmentId]').selectOption({ index: 1 }); await d.locator('[name=subject]').fill(`QA msg ${stamp}`); await d.locator('[name=body]').fill('Hello'); await submitDialog(p); return toastText(p); }, /sent/i);
    check('doctor: message in Sent', await listHas(p, '#msgs', `QA msg ${stamp}`));
    await go(p, '/doctor/patients');
    // open a patient this doctor is treating NOW (only they have the write buttons; "first in the list" depends on the date)
    const treating = await p.evaluate(async () => {
      const h = { Authorization: 'Bearer ' + localStorage.getItem('medicore_token') };
      const list = (await (await fetch('/api/doctor/patients?limit=100', { headers: h })).json()).data.items;
      for (const x of list) { const c = (await (await fetch('/api/doctor/patients/' + x.id, { headers: h })).json()).data; if (c && c.access && c.access.canWrite) return x.id; }
      return null;
    });
    await p.locator('#patients a[href="/doctor/patients/' + treating + '"]').click(); await p.waitForLoadState('networkidle'); await p.waitForTimeout(500);
    await step('doctor: add history record', p, async () => { await p.click('#record button:has-text("Diagnosis")'); await dlg(p).locator('[name=title]').fill(`QA condition ${stamp}`); await submitDialog(p); return toastText(p); }, /history/i);
    check('doctor: record listed', await listHas(p, '#record', `QA condition ${stamp}`));
    await step('doctor: upload report', p, async () => { await p.click('#record button:has-text("Upload report")'); const d = dlg(p); await d.locator('[name=title]').fill(`QA scan ${stamp}`); await d.locator('[name=file]').setInputFiles(PDF); await submitDialog(p); return toastText(p); }, /uploaded/i);
    await step('doctor: refer from record', p, async () => { await p.click('#record button:has-text("Refer")'); const d = dlg(p); check('doctor: referral patient preset', !(await d.locator('[name=patientId]').isVisible())); await d.locator('[name=toDoctorId]').selectOption({ index: 1 }); await d.locator('[name=reason]').fill(`QA referral ${stamp}`); await submitDialog(p); return toastText(p); }, /Referral sent/);
    await step('doctor: prescribe from record', p, async () => { await p.click('#record button:has-text("Prescribe")'); const d = dlg(p); await d.locator('[name=diagnosis]').fill(`QA dx ${stamp}`); await d.locator('[name=medicineName]').fill('Paracetamol'); await d.locator('[name=dosage]').fill('500 mg'); await d.locator('[name=frequency]').fill('Twice daily'); await submitDialog(p); return toastText(p); }, /issued/);
    await p.click('#tabs [data-value=prescriptions]'); await p.waitForTimeout(700);
    check('doctor: new prescription in record', await listHas(p, '[data-panel=prescriptions]', `QA dx ${stamp}`));
    await go(p, '/doctor/referrals');
    await p.click('#tabs [data-value=sent]'); await p.waitForTimeout(300);
    check('doctor: referral listed as sent', await listHas(p, '[data-panel=sent]', `QA referral ${stamp}`));
    await step('doctor: new referral (choose patient)', p, async () => { await p.click('#new-ref'); const d = dlg(p); await d.locator('[name=patientId]').selectOption({ index: 1 }); await d.locator('[name=toDoctorId]').selectOption({ index: 2 }); await d.locator('[name=reason]').fill('QA second referral'); await submitDialog(p); return toastText(p); }, /Referral sent/);
    await go(p, '/doctor/appointments');
    await step('doctor: consultation notes', p, async () => { await p.click('#scope [data-value=""]'); await p.selectOption('#status', 'COMPLETED'); await p.waitForTimeout(900); await p.locator('#appts [data-list] > *').first().getByRole('button', { name: 'Diagnosis and treatment' }).click(); const d = dlg(p); await d.locator('[name=treatment]').fill(`QA treatment ${stamp}`); await submitDialog(p); return toastText(p); }, /saved/i);
    const restoreSchedule = await putDoctorOnShiftAllWeek('david.chen@medicore.com', 'Doctor@123');
    // raise a fresh emergency (as a patient, through the API) for the doctor to handle
    const pt = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'patient@medicore.com', password: 'Patient@123' }) })).json();
    const raised = await fetch(`${B}/api/patient/emergencies`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${pt.token}` }, body: JSON.stringify({ priority: 'HIGH', symptoms: 'QA chest pain and palpitations' }) });
    check('test setup: emergency raised', raised.ok, String(raised.status));
    await go(p, '/doctor/emergencies');
    await step('doctor: escalate emergency', p, async () => { await p.locator('#board button:visible', { hasText: 'Escalate' }).first().click(); await dlg(p).locator('[name=reason]').fill('Needs cardiology senior'); await submitDialog(p); return toastText(p); }, /escalated/i);
    await step('doctor: accept emergency', p, async () => { await p.locator('#board button:visible', { hasText: 'Accept case' }).first().click(); await dlg(p).locator('[name=note]').fill('ETA 5 min'); await submitDialog(p); return toastText(p); }, /accepted/i);
    await step('doctor: resolve emergency', p, async () => { await p.waitForTimeout(600); await p.locator('#board button:visible', { hasText: 'Resolve' }).first().click(); await submitDialog(p); return toastText(p); }, /resolved/i);
    await p.waitForTimeout(800);
    check('doctor: active board empty with right title', (await p.getAttribute('#board', 'data-state')) === 'empty' && await p.locator('.only-active').isVisible() && !(await p.locator('.only-history').isVisible()));
    await restoreSchedule();
    await go(p, '/doctor/profile');
    await step('doctor: save profile', p, async () => { await p.fill('#profile-form [name=qualification]', 'MBBS, MD (QA)'); await p.click('#profile-form [type=submit]'); return toastText(p); }, /updated/i);
    await go(p, '/doctor/profile');
    check('doctor: profile change persisted', (await p.inputValue('#profile-form [name=qualification]')) === 'MBBS, MD (QA)');
    await go(p, '/doctor/schedule');
    await step('doctor: save schedule', p, async () => { await p.click('#save'); return toastText(p); }, /saved/i);
    await go(p, '/doctor/referrals');
    check('doctor: referrals load', ['ready', 'empty'].includes(await p.getAttribute('#refs', 'data-state')));
    check('doctor: no page errors', p.errors.length === 0, p.errors.join(' | ').slice(0, 300));
    await p.context().close();
  }

  if (!ONLY || ONLY === 'patient') {
    const p = await login(browser, 'patient@medicore.com', 'Patient@123');
    await go(p, '/patient/find-doctors');
    await p.locator('#directory a:has-text("View profile")').first().click(); await p.waitForURL('**/patient/doctors/*'); await p.waitForTimeout(800);
    check('patient: profile opened from directory', (await p.getAttribute('#profile', 'data-state')) === 'ready');
    await p.locator('#profile button:has-text("Book appointment")').click(); await p.waitForTimeout(400);
    check('patient: booking dialog from profile', (await dlg(p).count()) === 1 && /Choose a date/.test(await dlg(p).textContent()));
    await p.keyboard.press('Escape');
    await go(p, '/patient/medical-profile');
    await step('patient: save blood group', p, async () => { await p.selectOption('#blood-form [name=bloodGroup]', 'B_POS'); await p.click('#blood-form [type=submit]'); return toastText(p); }, /saved/i);
    // the page reloads its profile after the save: wait for it instead of reading the old value in the moment the toast appears
    await p.waitForFunction(() => /B\+/.test(document.querySelector('#blood-value')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
    check('patient: blood group shown', /B\+/.test(await p.textContent('#blood-value')));
    await step('patient: add allergy', p, async () => { await p.click('[data-add-allergy]'); await dlg(p).locator('[name=allergen]').fill(`QA pollen ${stamp}`); await submitDialog(p); return toastText(p); }, /saved/i);
    check('patient: allergy listed', await listHas(p, '#allergies', `QA pollen ${stamp}`));
    await step('patient: edit allergy', p, async () => { await row(p, `QA pollen ${stamp}`).getByRole('button', { name: 'Edit allergy' }).click(); check('patient: allergy form prefilled', (await dlg(p).locator('[name=allergen]').inputValue()) === `QA pollen ${stamp}`); await dlg(p).locator('[name=reaction]').fill('Sneezing QA'); await submitDialog(p); return toastText(p); }, /saved/i);
    check('patient: allergy edit shown', await listHas(p, '#allergies', 'Sneezing QA'));
    await step('patient: delete allergy', p, async () => { await row(p, `QA pollen ${stamp}`).getByRole('button', { name: 'Delete allergy' }).click(); await confirmOk(p); return toastText(p); }, /removed/i);
    check('patient: allergy removed', !(await listHas(p, '#allergies', `QA pollen ${stamp}`)));
    await step('patient: add condition', p, async () => { await p.locator('[data-add-record]').first().click(); await dlg(p).locator('[name=title]').fill(`QA asthma ${stamp}`); await submitDialog(p); return toastText(p); }, /saved/i);
    check('patient: condition listed', await listHas(p, '#conditions, #history', `QA asthma ${stamp}`));
    await step('patient: delete condition', p, async () => { await row(p, `QA asthma ${stamp}`).getByRole('button', { name: 'Delete record' }).click(); await confirmOk(p); return toastText(p); }, /removed/i);

    await go(p, '/patient/reports');
    await step('patient: upload report', p, async () => { await p.click('#upload-btn'); const d = dlg(p); await d.locator('[name=title]').fill(`QA blood test ${stamp}`); await d.locator('[name=file]').setInputFiles(PDF); await submitDialog(p); return toastText(p); }, /uploaded/i);
    check('patient: report listed', await listHas(p, '#reports', `QA blood test ${stamp}`));
    await step('patient: delete report', p, async () => { await row(p, `QA blood test ${stamp}`).getByRole('button', { name: 'Delete report' }).click(); await confirmOk(p); return toastText(p); }, /deleted/i);

    await go(p, '/patient/appointments');
    await step('patient: cancel appointment', p, async () => { await p.locator('#appts button:visible', { hasText: /^Cancel/ }).first().click(); await confirmOk(p); return toastText(p); }, /cancelled/i);
    await go(p, '/patient/appointments?tab=past');
    await step('patient: rate past visit', p, async () => { for (let i = 0; i < 5 && !(await p.locator('#appts button:visible', { hasText: 'Rate visit' }).count()); i += 1) { await p.click('#appts [data-pager-next]'); await p.waitForTimeout(700); } await p.locator('#appts button:visible', { hasText: 'Rate visit' }).first().click(); await dlg(p).locator('label[for=r4]').click(); await submitDialog(p); return toastText(p); }, /thank/i);

    await go(p, '/patient/profile');
    await step('patient: save profile', p, async () => { await p.fill('#profile-form [name=address]', `QA address ${stamp}`); await p.click('#profile-form [type=submit]'); return toastText(p); }, /updated/i);
    await go(p, '/patient/complaints');
    await step('patient: submit complaint', p, async () => { await p.click('#new-complaint'); const d = dlg(p); await d.locator('[name=subject]').fill(`QA complaint ${stamp}`); await d.locator('[name=description]').fill('Testing the complaint form'); await submitDialog(p); return toastText(p); }, /submitted/i);
    check('patient: complaint listed', await listHas(p, '#complaints', `QA complaint ${stamp}`));
    await go(p, '/patient/settings');
    await step('patient: password mismatch rejected', p, async () => { await p.fill('#password-form [name=currentPassword]', 'Patient@123'); await p.fill('#password-form [name=newPassword]', 'Patient@999'); await p.fill('#pw-confirm', 'Patient@998'); await p.click('#password-form [type=submit]'); return toastText(p, 'error'); }, /match/i);
    await step('patient: change password', p, async () => { await p.fill('#pw-confirm', 'Patient@999'); await p.click('#password-form [type=submit]'); return toastText(p); }, /changed/i);
    await step('patient: change password back', p, async () => { await p.fill('#password-form [name=currentPassword]', 'Patient@999'); await p.fill('#password-form [name=newPassword]', 'Patient@123'); await p.fill('#pw-confirm', 'Patient@123'); await p.click('#password-form [type=submit]'); return toastText(p); }, /changed/i);
    await go(p, '/patient/appointments'); await p.waitForTimeout(1500);
    check('patient: still signed in after changing password (renewed token)', new URL(p.url()).pathname === '/patient/appointments' && (await p.getAttribute('#appts', 'data-state')) !== 'error');
    check('patient: live connection re-established with the renewed token', await p.evaluate(() => document.documentElement.classList.contains('is-live')));
    await go(p, '/patient/notifications');
    await step('patient: mark all notifications read', p, async () => { await p.click('[data-markall]'); await p.waitForTimeout(800); return p.textContent('[data-unread-count]'); }, /^0$/);
    await go(p, '/patient/emergency');
    await step('patient: send emergency request', p, async () => { await p.click('label:has-text("Medium")'); await p.fill('#em-form [name=symptoms]', `QA sudden dizziness ${stamp}`); await p.click('#em-form [type=submit]'); return toastText(p); }, /alerted/i);
    check('patient: tracker shows active request', await listHas(p, '#em', `QA sudden dizziness ${stamp}`) && await p.locator('#em .steps li.is-done').count() >= 1);
    await step('patient: cancel emergency request', p, async () => { await p.click('#em button:has-text("Cancel request")'); await confirmOk(p); return toastText(p); }, /cancelled/i);
    await p.waitForTimeout(800);
    check('patient: form back, request in history', (await p.getAttribute('#em', 'data-state')) === 'empty' && await listHas(p, '#em-history', `QA sudden dizziness ${stamp}`));
    check('patient: no page errors', p.errors.length === 0, p.errors.join(' | ').slice(0, 300));
    await p.context().close();
  }

  if (!ONLY || ONLY === 'public') {
    const p = await login(browser);
    await go(p, '/doctors');
    await p.locator('#directory a:has-text("View profile")').first().click(); await p.waitForURL('**/doctors/*'); await p.waitForTimeout(800);
    await step('public: guest booking goes to login', p, async () => { await p.locator('#profile button:has-text("Book appointment")').click(); await p.waitForURL('**/login**'); return decodeURIComponent(p.url()); }, /next=\/doctors\//);
    await go(p, '/contact');
    await step('public: contact form', p, async () => { await p.fill('#contact-form [name=name]', 'QA Visitor'); await p.fill('#contact-form [name=email]', 'qa@example.com'); await p.fill('#contact-form [name=subject]', `QA contact ${stamp}`); await p.fill('#contact-form [name=message]', 'Testing the contact form'); await p.click('#contact-form [type=submit]'); return toastText(p); }, /./);
    await go(p, '/register');
    await step('public: register validation', p, async () => { await p.fill('#register-form [name=fullName]', 'QA New'); await p.fill('#register-form [name=email]', `qa.new${stamp}@example.com`); await p.fill('#register-form [name=password]', 'short'); await p.click('#register-form [type=submit]'); await p.waitForTimeout(300); const hint = p.locator('[data-error=password]'); return (await hint.isVisible()) && !(await p.url()).includes('/patient') ? await hint.textContent() : 'hint hidden'; }, /8 characters/);
    await step('public: register account', p, async () => { await p.fill('#register-form [name=password]', 'Welcome@123'); await p.fill('#r-confirm', 'Welcome@123'); await p.check('#r-agree', { force: true }); await p.click('#register-form [type=submit]'); await p.waitForURL('**/patient/medical-profile'); return 'ok'; }, /ok/);
    check('public: no page errors', p.errors.length === 0, p.errors.join(' | ').slice(0, 300));
    await p.context().close();
  }

  await browser.close();
  console.log(`${results.join('\n')}\n${failed ? `${failed} FAILED` : 'ALL ACTIONS PASSED'} (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
})();
