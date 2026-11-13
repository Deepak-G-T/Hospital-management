/* eslint-disable no-console */
// Cross-portal interactive flow through the real UI (needs freshly seeded DB, API :5000, Vite :5173).
// Patient books → doctor sees it live and accepts → patient sees "Confirmed" live;
// patient raises an emergency → doctor sees it live and accepts → patient sees the doctor assigned.
// Usage: node tests/flow.cjs            (desktop)   |   VIEWPORT=phone node tests/flow.cjs
const { chromium, devices } = require('playwright');

const B = process.env.WEB_URL || 'http://localhost:5173';
const PHONE = process.env.VIEWPORT === 'phone';
const ctxOpts = PHONE ? { ...devices['iPhone 13'] } : { viewport: { width: 1440, height: 900 } };
const results = []; let failed = 0;
const check = (name, ok) => { results.push(`  ${ok ? '✔' : '✘'} ${name}`); if (!ok) failed += 1; };

async function login(browser, email, pw) {
  const c = await browser.newContext(ctxOpts);
  const p = await c.newPage();
  p.on('pageerror', (e) => { failed += 1; results.push(`  ✘ pageerror: ${e.message}`); });
  await p.goto(`${B}/login`, { waitUntil: 'networkidle' });
  await p.fill('input[type=email]', email); await p.fill('input[type=password]', pw);
  await p.click('button[type=submit]');
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
  await p.waitForLoadState('networkidle');
  return p;
}

(async () => {
  const browser = await chromium.launch();
  const doc = await login(browser, 'priya.raman@medicore.com', 'Doctor@123');
  await doc.goto(`${B}/doctor/appointments`, { waitUntil: 'networkidle' });
  const unreadOf = async () => Number((await doc.locator('header button[aria-label^="Notifications"]').getAttribute('aria-label')).match(/\((\d+) unread\)/)[1]);
  const unreadBefore = await unreadOf();
  const pat = await login(browser, 'patient@medicore.com', 'Patient@123');

  // 1) Patient books Dr. Priya Raman
  if (PHONE) { await pat.click('nav[aria-label="Quick navigation"] a:visible:has-text("Doctors")'); await pat.waitForURL('**/patient/find-doctors'); }
  else await pat.goto(`${B}/patient/find-doctors`, { waitUntil: 'networkidle' });
  await pat.fill('input[placeholder^="Search by name"]', 'Priya');
  await pat.waitForTimeout(900);
  await pat.locator('button', { hasText: /^Book$/ }).first().click();
  await pat.waitForSelector('text=Choose a date & time');
  const dayButtons = pat.locator('dialog[open] .days button');
  // A slot that is free for the DOCTOR can still clash with an appointment the patient already has (the seed spreads them over the coming weeks,
  // so which slot clashes depends on today's date): when the booking is refused, take the next free slot instead of failing the flow.
  let picked = false; let booked = false; let attempts = 0;
  for (let i = 1; i < 12 && !booked; i += 1) {
    await dayButtons.nth(i).click(); await pat.waitForTimeout(500);
    const slots = pat.locator('dialog[open] .slots button:not([disabled])');
    for (let k = 0; k < await slots.count() && !booked && attempts < 12; k += 1) {
      await slots.nth(k).click(); picked = true; attempts += 1;
      await pat.fill('textarea[placeholder^="e.g. Recurring"]', 'UI flow test booking');
      await pat.click('button:has-text("Confirm booking")');
      const outcome = await Promise.race([pat.waitForURL('**/patient/appointments', { timeout: 6000 }).then(() => 'booked').catch(() => 'refused'), pat.locator('.toast.is-error').first().waitFor({ timeout: 6000 }).then(() => 'refused').catch(() => 'booked')]);
      booked = outcome === 'booked' && /\/patient\/appointments/.test(pat.url());
      if (!booked) await pat.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    }
  }
  check('patient picked a free slot in the booking sheet', picked);
  check('booking accepted (taking the next slot if one clashed with the patient\'s own appointments)', booked);
  await pat.waitForURL('**/patient/appointments');
  await pat.waitForTimeout(800);
  check('booking appears in patient appointments', (await pat.locator('text=UI flow test booking').count()) > 0);

  // 2) Doctor gets it live (no reload) and accepts
  await doc.waitForTimeout(1500);
  const unreadAfter = await unreadOf();
  check(`doctor's unread count rose live without reload (${unreadBefore} → ${unreadAfter})`, unreadAfter > unreadBefore);
  const row = doc.locator('tr', { hasText: 'John Carter' }).filter({ has: doc.locator('button[title="Accept"]') }).first();
  check('booking request visible to doctor without reload', (await row.count()) > 0);
  await row.locator('button[title="Accept"]').click();
  await doc.click('dialog[open] button:has-text("Accept")');
  await doc.waitForTimeout(1500);

  // 3) Patient view updates live
  const card = pat.locator('.card', { hasText: 'UI flow test booking' }).first();
  check('patient sees status change to Confirmed live', /Confirmed/.test(await card.innerText()));

  // 4) Emergency: patient → doctor live → accept → patient sees doctor
  await doc.goto(`${B}/doctor/emergencies`, { waitUntil: 'networkidle' });
  if (PHONE) { await pat.click('nav[aria-label="Quick navigation"] a:visible:has-text("SOS")'); await pat.waitForURL('**/patient/emergency'); await pat.waitForLoadState('networkidle'); }
  else await pat.goto(`${B}/patient/emergency`, { waitUntil: 'networkidle' });
  await pat.click('label:has-text("Critical")');
  await pat.fill('textarea[placeholder^="e.g. Severe chest"]', 'Sudden seizure and numbness on left side');
  await pat.click('button:has-text("Send emergency request")');
  await pat.waitForSelector('text=Your emergency request is active', { timeout: 10000 });
  check('patient sees active emergency tracker', true);
  await doc.waitForTimeout(2000);
  const emCard = doc.locator('.card', { hasText: 'Sudden seizure' }).first();
  check('doctor sees the emergency live', (await emCard.count()) > 0);
  await emCard.locator('button:has-text("Accept case")').click();
  await doc.click('dialog[open] button:has-text("Confirm")');
  await pat.waitForTimeout(2500);
  check('patient sees the doctor accepted (live)', (await pat.locator('text=is handling your case').count()) > 0);
  const vw = await pat.evaluate(() => document.documentElement.scrollWidth);
  check(`no horizontal overflow after the flow (${vw}px)`, vw <= (PHONE ? 390 : 1440));

  await browser.close();
  console.log(`Cross-portal flow (${PHONE ? 'phone' : 'desktop'}):\n${results.join('\n')}\n${failed ? `${failed} FAILED` : 'ALL PASSED'}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
