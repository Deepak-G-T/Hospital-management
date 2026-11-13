/* eslint-disable no-console */
// Automatic emergency escalation through the real UI (P1 item 6).
// Needs a freshly seeded *test* database and an API started with fast test-only targets, e.g.
//   ESCALATION_TARGETS="CRITICAL=0.05,HIGH=0.1,MEDIUM=0.15,LOW=0.2" ESCALATION_MAX_LEVEL=1 ESCALATION_POLL_SECONDS=0.5 node src/server.js
// (max level 1: no later level is pushed live after the reconnect, so only the catch-up can update the page)
// Doctor acknowledges (not accepting) → escalation pauses then resumes while the doctor is offline → on reconnect the
// bell and board catch up → admin sees the banner, the escalation record and acknowledges the next level → doctor accepts.
// Usage: WEB_URL=http://localhost:8089 node tests/escalation-ui.cjs
//   DISCONNECT_CMD / RECONNECT_CMD (optional): shell commands that cut and restore the browser's connection to the API
//   (e.g. stop/start the reverse proxy) so the reconnect catch-up is tested with a real dropped socket.
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const B = process.env.WEB_URL || 'http://localhost:5173';
const results = []; let failed = 0;
const check = (name, ok, extra = '') => { results.push(`  ${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${extra}`}`); if (!ok) failed += 1; };

async function api(method, p, token, body) {
  const res = await fetch(`${B}/api${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}
async function login(browser, email, pw) {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await c.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource|WebSocket|ERR_INTERNET_DISCONNECTED/.test(m.text())) p.errors.push(m.text()); });
  await p.goto(`${B}/login`, { waitUntil: 'networkidle' });
  await p.fill('input[type=email]', email); await p.fill('input[type=password]', pw);
  await p.click('button[type=submit]');
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
  return p;
}
const unreadOf = async (p) => Number((await p.locator('header button[aria-label^="Notifications"]').getAttribute('aria-label')).match(/\((\d+) unread\)/)[1]);

(async () => {
  const adminToken = (await api('POST', '/auth/login', null, { email: 'admin@medicore.com', password: 'Admin@123' })).token;
  const cfg = (await api('GET', '/admin/escalation-config', adminToken)).data;
  if (!cfg?.enabled || cfg.targetsMinutes.CRITICAL > 0.2 || cfg.maxLevel !== 1) {
    console.log('Skipped: start the API with fast test-only ESCALATION_TARGETS (CRITICAL ≤ 0.2 min) and ESCALATION_MAX_LEVEL=1'); process.exit(0);
  }
  const waitMs = cfg.targetsMinutes.CRITICAL * 60000;
  const cardiology = (await api('GET', '/public/departments')).data.find((d) => d.name === 'Cardiology');
  const email = `esc.ui.${Date.now()}@example.com`;
  const patient = await api('POST', '/auth/register', null, { email, password: 'Start@1234', fullName: 'Escalation UiTest' });
  const em = (await api('POST', '/patient/emergencies', patient.token, { priority: 'CRITICAL', departmentId: cardiology.id, symptoms: 'Synthetic UI test — chest pain' })).data;

  const browser = await chromium.launch();
  const doc = await login(browser, 'david.chen@medicore.com', 'Doctor@123'); // Cardiology
  await doc.goto(`${B}/doctor/emergencies`, { waitUntil: 'networkidle' });
  const card = doc.locator('article', { hasText: 'Escalation UiTest' });
  await card.waitFor({ timeout: 8000 });
  check('doctor board shows the new case with Acknowledge and Accept', await card.locator('button:has-text("Acknowledge")').isVisible() && await card.locator('button:has-text("Accept case")').isVisible());
  check('card shows when the next automatic alert is due', /Next automatic alert at/.test(await card.innerText()));

  await card.locator('button:has-text("Acknowledge")').click();
  const confirmText = await doc.locator('#confirm-dialog').textContent();
  check('confirmation explains acknowledgement is not acceptance', /does not accept or assign/.test(confirmText));
  await doc.click('#confirm-dialog [data-confirm-ok]');
  await doc.locator('.toast.is-success').last().waitFor({ timeout: 6000 });
  await doc.waitForTimeout(800);
  const after = await card.innerText();
  check('after acknowledging: "Acknowledged by … assessing, not accepted", button gone, case still open', /Acknowledged by david\.chen@medicore\.com .* assessing, not accepted/.test(after) && !(await card.locator('button:has-text("Acknowledge")').isVisible()) && await card.locator('button:has-text("Accept case")').isVisible());

  // Doctor's connection drops; escalation resumes after the pause; nothing can be pushed to them meanwhile
  const unreadBefore = await unreadOf(doc);
  const realDrop = Boolean(process.env.DISCONNECT_CMD && process.env.RECONNECT_CMD);
  if (realDrop) execSync(process.env.DISCONNECT_CMD, { stdio: 'ignore' });
  else await doc.context().setOffline(true);
  await doc.waitForFunction(() => !document.documentElement.classList.contains('is-live'), null, { timeout: 15000 }).catch(() => {});
  const dropped = !(await doc.evaluate(() => document.documentElement.classList.contains('is-live')));
  if (realDrop) check('doctor connection dropped', dropped);
  const deadline = Date.now() + waitMs * 2 + 10000;
  let level = 0;
  const viaApi = realDrop ? `http://localhost:${process.env.DIRECT_API_PORT || 5001}/api` : `${B}/api`; // the proxy is down
  while (Date.now() < deadline && level < 1) {
    await new Promise((r) => setTimeout(r, 300));
    level = (await (await fetch(`${viaApi}/admin/emergencies/${em.id}`, { headers: { Authorization: `Bearer ${adminToken}` } })).json()).data.autoEscalationLevel;
  }
  check('escalation resumed after the acknowledgement pause while the doctor was disconnected', level >= 1);
  await doc.waitForTimeout(500);
  const unreadWhileOffline = await unreadOf(doc);
  if (realDrop) check('nothing reached the disconnected browser', unreadWhileOffline === unreadBefore && !/Auto-alert level/.test(await card.innerText()));
  if (realDrop) execSync(process.env.RECONNECT_CMD, { stdio: 'ignore' });
  else await doc.context().setOffline(false);
  await doc.waitForFunction(() => document.documentElement.classList.contains('is-live'), null, { timeout: 30000 }).catch(() => {});
  if (realDrop) check('browser reconnected', await doc.evaluate(() => document.documentElement.classList.contains('is-live')));
  await doc.waitForTimeout(1500);
  check(`${realDrop ? 'on reconnect' : 'live'}: the bell has the escalation notification`, (await unreadOf(doc)) > unreadBefore, `${unreadBefore} → ${await unreadOf(doc)}`);
  check(`${realDrop ? 'on reconnect' : 'live'}: the board shows the auto-alert level`, /Auto-alert level [1-3] of 3/.test(await card.innerText()));
  if (!realDrop) results.push('  ○ real disconnect/reconnect not tested (set DISCONNECT_CMD and RECONNECT_CMD)');

  // Admin view
  const adm = await login(browser, 'admin@medicore.com', 'Admin@123');
  await adm.goto(`${B}/admin/emergencies`, { waitUntil: 'networkidle' });
  const banner = await adm.locator('#escalation-config').textContent();
  check('admin banner states automatic escalation is on, provisional and not a replacement for emergency services', /Automatic escalation is on/.test(banner) && /not clinically validated/.test(banner) && /do not replace emergency services/.test(banner));
  await adm.locator('#list button', { hasText: 'Escalation UiTest' }).click();
  const dialog = adm.locator('#em-dialog');
  await dialog.locator('text=Automatic escalation').first().waitFor({ timeout: 5000 });
  const dText = await dialog.textContent();
  check('admin dialog lists escalation levels and states priority is never changed automatically', /Level 1 ·/.test(dText) && /never changes priority/.test(dText));
  const ackBtn = dialog.locator('button:has-text("Acknowledge")');
  check('admin can acknowledge the new level', await ackBtn.isVisible());
  await ackBtn.click();
  await adm.click('#confirm-dialog [data-confirm-ok]');
  await adm.locator('.toast.is-success').last().waitFor({ timeout: 6000 });
  await adm.waitForTimeout(800);
  check('after admin acknowledgement the button is hidden', !(await ackBtn.isVisible()));
  check('priority still CRITICAL after automatic escalation', (await api('GET', `/admin/emergencies/${em.id}`, adminToken)).data.priority === 'CRITICAL');

  // Doctor accepts → automatic escalation stops
  await card.locator('button:has-text("Accept case")').click();
  await doc.locator('#accept-dialog [type=submit]').click();
  await doc.locator('.toast.is-success').last().waitFor({ timeout: 6000 });
  const accepted = (await api('GET', `/admin/emergencies/${em.id}`, adminToken)).data;
  check('accepting stops automatic escalation', accepted.status === 'ACCEPTED' && accepted.nextEscalationAt === null);
  await doc.waitForTimeout(800);
  check('accepted card no longer shows a next automatic alert', !/Next automatic alert/.test(await card.innerText()));
  await api('POST', `/doctor/emergencies/${em.id}/resolve`, (await api('POST', '/auth/login', null, { email: 'david.chen@medicore.com', password: 'Doctor@123' })).token, {});

  for (const [n, p] of [['doctor', doc], ['admin', adm]]) check(`no console/page errors (${n})`, !p.errors.length, p.errors.join(' | '));
  await browser.close();
  console.log(results.join('\n'));
  console.log(failed ? `\nFAILED (${failed})` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
