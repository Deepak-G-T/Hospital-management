/* eslint-disable no-console */
// The website's handling of the standardised API responses (needs a freshly seeded *test* database and API behind WEB_URL).
//   login: success and real failures; a gateway's HTML error page; a 500 with a request id; validation messages; 429
//   portals: expired token redirect; a server error on a list shows a readable error state (no raw HTML / JSON)
// Usage: WEB_URL=http://localhost:8089 node tests/api-errors-ui.cjs
const { chromium } = require('playwright');

const B = process.env.WEB_URL || 'http://localhost:5173';
const results = []; let failed = 0;
const check = (name, ok, extra = '') => { results.push(`  ${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${extra}`}`); if (!ok) failed += 1; };
const json = (status, body, headers = {}) => ({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });

async function page(browser) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await c.newPage(); p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  return p;
}
async function tryLogin(p, email, password) {
  await p.goto(`${B}/login`, { waitUntil: 'networkidle' });
  await p.fill('input[type=email]', email); await p.fill('input[type=password]', password);
  await p.click('button[type=submit]');
}
const loginError = async (p) => { const e = p.locator('[role=alert], .alert-error, #login-error').first(); await e.waitFor({ timeout: 6000 }); return (await e.textContent()).trim(); };

(async () => {
  const browser = await chromium.launch();

  // ── real flows ──
  let p = await page(browser);
  await tryLogin(p, 'admin@medicore.com', 'definitely-wrong-1');
  const wrong = await loginError(p);
  check('login: a real wrong password shows the API message (401 UNAUTHENTICATED)', /invalid|incorrect|wrong/i.test(wrong), wrong);
  await p.fill('input[type=password]', 'Admin@123'); await p.click('button[type=submit]');
  await p.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 10000 });
  check('login: success still signs in (token and user now come from data)', true);
  await p.waitForSelector('[data-bell]', { timeout: 8000 });
  check('portal: /auth/me session loads after login', (await p.evaluate(() => localStorage.getItem('medicore_role'))) === 'ADMIN');

  // ── injected failures on the login form ──
  p = await page(browser);
  await p.route('**/api/auth/login', (r) => r.fulfill({ status: 502, contentType: 'text/html', body: '<html><body><h1>502 Bad Gateway</h1><p>nginx/1.24</p></body></html>' }));
  await tryLogin(p, 'a@b.com', 'whatever1!');
  const gw = await loginError(p);
  check('a gateway HTML error page becomes a readable message, not raw HTML', /server had a problem/i.test(gw) && !/<h1>|nginx|Bad Gateway/.test(gw), gw);

  await p.unroute('**/api/auth/login');
  await p.route('**/api/auth/login', (r) => r.fulfill(json(400, { success: false, message: 'email: Invalid email', error: { code: 'VALIDATION_ERROR', status: 400, details: [{ field: 'email', message: 'Invalid email' }] }, details: [{ field: 'email', message: 'Invalid email' }], requestId: 'abc12345-0000' })));
  await tryLogin(p, 'a@b.com', 'whatever1!');
  check('a validation error shows the API message', /Invalid email/.test(await loginError(p)));

  await p.unroute('**/api/auth/login');
  await p.route('**/api/auth/login', (r) => r.fulfill(json(429, { success: false, message: 'Too many failed sign-in attempts for this account. Try again in 15 minute(s).', error: { code: 'ACCOUNT_LOCKED', status: 429, details: { retryAfterSeconds: 900 } }, details: { retryAfterSeconds: 900 }, requestId: 'abc12345-0001' }, { 'Retry-After': '900' })));
  await tryLogin(p, 'a@b.com', 'whatever1!');
  check('an account lock (429) shows its message', /Too many failed sign-in attempts/.test(await loginError(p)));

  // ── the ApiError object the pages receive ──
  p = await page(browser);
  await tryLogin(p, 'admin@medicore.com', 'Admin@123');
  await p.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 10000 });
  await p.route('**/api/admin/dashboard*', (r) => r.fulfill(json(500, { success: false, message: 'Something went wrong. Please try again later.', error: { code: 'INTERNAL_ERROR', status: 500 }, requestId: 'deadbeef-1234-5678' })));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  const body = await p.locator('body').innerText();
  check('a 500 on a page shows a readable error state (no raw JSON or error codes on screen)', /Something went wrong|could not|failed/i.test(body) && !/INTERNAL_ERROR|requestId|\{"success"/.test(body));
  check('no uncaught script errors in the pages above', !p.errors.length, p.errors.join(' | '));

  // ── expired session ──
  p = await page(browser);
  await tryLogin(p, 'admin@medicore.com', 'Admin@123');
  await p.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 10000 });
  await p.route('**/api/admin/patients*', (r) => r.fulfill(json(401, { success: false, message: 'Session expired or invalid. Please log in again.', error: { code: 'UNAUTHENTICATED', status: 401 }, requestId: 'expired-0000-1111' })));
  await p.goto(`${B}/admin/patients`, { waitUntil: 'networkidle' });
  await p.waitForURL((u) => u.pathname.startsWith('/login'), { timeout: 8000 });
  check('a 401 on a portal page signs the user out and returns to the login page with ?expired=1', /expired=1/.test(p.url()));

  await browser.close();
  console.log(results.join('\n'));
  console.log(failed ? `\nFAILED (${failed})` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
