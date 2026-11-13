/* eslint-disable no-console */
// Swagger UI at /api/docs, loaded in a real browser through the website's proxy (strict Content-Security-Policy, no inline scripts).
//   WEB_URL=http://localhost:8089 node tests/api-docs-ui.cjs        (needs the API running; no login required)
const { chromium } = require('playwright');

const B = process.env.WEB_URL || 'http://localhost:5173';
const results = []; let failed = 0;
const check = (name, ok, extra = '') => { results.push(`  ${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${extra}`}`); if (!ok) failed += 1; };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const problems = []; const external = [];
  p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  p.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/favicon/.test(m.text())) problems.push(`${m.type()}: ${m.text().slice(0, 160)}`); });
  p.on('request', (r) => { if (!r.url().startsWith(B)) external.push(r.url()); });

  const spec = await (await ctx.request.get(`${B}/api/openapi.json`)).json(); // what the page should show
  const specOps = Object.values(spec.paths).flatMap((o) => Object.keys(o).map((m) => m.toUpperCase()));
  const op = (path) => p.locator(`.opblock:has(.opblock-summary-path[data-path="${path}"])`).first();
  await p.goto(`${B}/api/docs`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.swagger-ui .opblock-tag', { timeout: 15000 });
  check('Swagger UI loads at /api/docs under the strict CSP (no console errors, no CSP violations)', problems.length === 0, problems.join(' | '));
  check('the page makes no request to any other host', external.length === 0, external.join(' '));
  check('title and version come from the OpenAPI document', /MediCore Smart Hospital API/.test(await p.locator('.swagger-ui .info .title').innerText()) && /OAS 3\.1/.test(await p.locator('.swagger-ui .info').innerText()));
  const tags = await p.locator('.opblock-tag-section').count();
  check(`all ${spec.tags.length} tag groups are listed`, tags === spec.tags.length, `found ${tags}`);

  // expand every group, count operations
  const heads = p.locator('.opblock-tag-section h3.opblock-tag');
  for (let i = 0; i < await heads.count(); i += 1) await heads.nth(i).click();
  await p.waitForTimeout(500);
  const ops = await p.locator('.opblock').count();
  check('all 112 operations are shown', ops === 112 && specOps.length === 112, `found ${ops}`);
  const methods = await p.locator('.opblock-summary-method').allInnerTexts();
  const by = (m) => methods.filter((x) => x === m).length;
  const want = (m) => specOps.filter((x) => x === m).length;
  check('methods shown match the document (GET/POST/PUT/PATCH/DELETE)', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].every((m) => by(m) === want(m)), JSON.stringify({ GET: by('GET'), POST: by('POST'), PUT: by('PUT'), PATCH: by('PATCH'), DELETE: by('DELETE') }));

  // JWT bearer authentication is documented and can be entered
  await p.locator('.authorize').first().click();
  const modal = p.locator('.modal-ux');
  await modal.waitFor();
  const authText = await modal.innerText();
  check('the Authorize dialog documents the bearer JWT scheme', /bearerAuth/.test(authText) && /JWT/.test(authText) && /Bearer/i.test(authText));
  await modal.locator('#auth-bearer-value').fill('not-a-real-token');
  await modal.locator('button.authorize').click();
  await modal.locator('button.btn-done').click();
  const protectedOps = Object.values(spec.paths).flatMap((o) => Object.values(o)).filter((x) => x.security && x.security.length).length;
  const pads = await p.locator('.authorization__btn').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || ''));
  check(`all ${protectedOps} protected operations (and only those) show a padlock, locked after authorising`, pads.length === protectedOps && pads.every((l) => /locked/.test(l) && !/unlocked/.test(l)), `${pads.length} padlocks: ${[...new Set(pads)].join(' / ')}`);

  // an operation: login — body schema, example, error responses
  await p.locator('#operations-Authentication-postAuthLogin .opblock-summary').click();
  const login = p.locator('#operations-Authentication-postAuthLogin');
  await login.waitFor();
  const lt = await login.innerText();
  check('POST /auth/login documents its request body, example and 400, 401 and 429 errors', /email/.test(lt) && /password/.test(lt) && /\b400\b/.test(lt) && /\b401\b/.test(lt) && /\b429\b/.test(lt) && /VALIDATION_ERROR|UNAUTHENTICATED/.test(lt), lt.slice(0, 200));

  // downloads are documented as files, not JSON
  await p.locator('#operations-Files-getFilesPrescriptionsByIdPdf .opblock-summary').click();
  const pdf = await p.locator('#operations-Files-getFilesPrescriptionsByIdPdf').innerText();
  check('the prescription PDF download is documented as application/pdf', /application\/pdf/.test(pdf) && /Content-Disposition/.test(pdf));
  await op('/admin/reports/{type}').locator('.opblock-summary').click();
  const csv = await op('/admin/reports/{type}').innerText();
  check('the report endpoint documents both JSON and a CSV download', /text\/csv/.test(csv) && /application\/json/.test(csv));

  // "Try it out" against the real API: the public health check
  const health = op('/health');
  await health.locator('.opblock-summary').click();
  await health.getByRole('button', { name: 'Try it out' }).click();
  await health.getByRole('button', { name: 'Execute' }).click();
  await health.getByText('Server response').waitFor({ timeout: 10000 });
  const live = await health.innerText();
  check('Try it out works against the live API (GET /health → 200 with a request id)', /Server response\s+Code\s+Details\s+200/.test(live) && /x-request-id:/i.test(live) && /"status": "ok"/.test(live), live.slice(-300));
  check('no console errors during use', problems.length === 0, problems.join(' | '));

  // the raw document, as served
  check('/api/openapi.json is OpenAPI 3.1 with 112 operations', spec.openapi === '3.1.0' && specOps.length === 112);
  const missing = await ctx.request.get(`${B}/api/docs/assets/package.json`);
  check('files other than the three Swagger UI assets are not served', missing.status() === 404);

  await browser.close();
  console.log(results.join('\n'));
  console.log(failed ? `\nFAILED (${failed})` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
