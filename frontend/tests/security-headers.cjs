// P0 security-header test for the production setup (built site behind the README's Nginx config).
// Usage: npm run build, serve dist/ with the README Nginx config, then
//   WEB_URL=http://localhost:8080 node tests/security-headers.cjs
// Checks: CSP / Referrer-Policy / Permissions-Policy on every kind of page (incl. 404), a strict script-src,
// no inline scripts or inline event handlers in the build, and that the browser really blocks an injected inline script.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const B = process.env.WEB_URL;
if (!B) { console.error('Set WEB_URL to the Nginx-served site, e.g. WEB_URL=http://localhost:8080'); process.exit(2); }
const results = [];
let failed = 0;
const check = (name, ok, extra = '') => { results.push(`  ${ok ? '✔' : '✘'} ${name}${ok ? '' : ` — ${extra}`}`); if (!ok) failed += 1; };

(async () => {
  // 1. Headers on pages, a clean-URL page, a rewritten page and the 404 page
  for (const p of ['/', '/login', '/admin/doctors', '/doctors/some-id', '/does-not-exist']) {
    const res = await fetch(B + p);
    const csp = res.headers.get('content-security-policy') || '';
    check(`${p} (${res.status}) sends Content-Security-Policy`, Boolean(csp), 'missing');
    check(`${p} sends Referrer-Policy: strict-origin-when-cross-origin`, res.headers.get('referrer-policy') === 'strict-origin-when-cross-origin', res.headers.get('referrer-policy'));
    const pp = res.headers.get('permissions-policy') || '';
    check(`${p} sends Permissions-Policy (geolocation for this site only, no camera/microphone)`, /geolocation=\(self\)/.test(pp) && /camera=\(\)/.test(pp) && /microphone=\(\)/.test(pp), pp);
    if (p === '/') {
      const scriptSrc = (csp.match(/script-src ([^;]*)/) || [])[1] || '';
      check("CSP script-src is 'self' only (no unsafe-inline / unsafe-eval)", scriptSrc.trim() === "'self'", scriptSrc);
      for (const d of ["object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "connect-src 'self'"]) check(`CSP contains ${d}`, csp.includes(d), csp);
    }
  }

  // 2. The build has no inline scripts or inline event handlers (they would be blocked by the CSP)
  const dist = path.join(__dirname, '../dist');
  const pages = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.html') && pages.push(path.join(d, e.name))));
  walk(dist);
  const inlineScripts = pages.filter((f) => /<script(?![^>]*\bsrc=)[^>]*>/i.test(fs.readFileSync(f, 'utf8')));
  const inlineHandlers = pages.filter((f) => /\son[a-z]+\s*=\s*["']/i.test(fs.readFileSync(f, 'utf8')));
  check(`no inline <script> in ${pages.length} built pages`, inlineScripts.length === 0, inlineScripts.join(', '));
  check(`no inline event handlers (on…=) in ${pages.length} built pages`, inlineHandlers.length === 0, inlineHandlers.join(', '));

  // 3. In a real browser: the page works, the theme script runs, an injected inline script is blocked
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${B}/login`, { waitUntil: 'networkidle' });
  check('theme is applied by the external theme.js under the CSP', Boolean(await page.evaluate(() => document.documentElement.dataset.theme)));
  check('page loads without CSP violations', errors.length === 0, errors.join(' | ').slice(0, 300));
  const blocked = await page.evaluate(() => new Promise((resolve) => {
    window.injected = false;
    document.addEventListener('securitypolicyviolation', (e) => resolve({ violated: e.violatedDirective, ran: window.injected }), { once: true });
    const s = document.createElement('script'); s.textContent = 'window.injected = true'; document.body.append(s);
    setTimeout(() => resolve({ violated: null, ran: window.injected }), 1500);
  }));
  check('an injected inline script is blocked by the browser', blocked.ran === false && /script-src/.test(blocked.violated || ''), JSON.stringify(blocked));
  await browser.close();

  console.log(`Security headers (${B}):\n${results.join('\n')}\n${failed ? `${failed} FAILED` : 'ALL PASSED'}`);
  process.exit(failed ? 1 : 0);
})();
