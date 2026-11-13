// Serves the API documentation: Swagger UI at /api/docs and the OpenAPI document at /api/openapi.json.
// Plain middleware (not a Router), so it is not part of the route inventory that tests/api-contract.test.js and docs/openapi.json describe.
// Mounted in app.js after the rate limiter and before the API router. Responses carry the same security headers (helmet) as the API.
//
// Availability: on in development and test; OFF in production unless API_DOCS=true (the document lists every endpoint and role,
// which is not for the public). It holds no secrets and only fictitious example data. Only the three Swagger UI files below are served.
const fs = require('fs');
const path = require('path');
const ApiError = require('../utils/ApiError');
const { isProd } = require('../config/env');

const SPEC_FILE = path.join(__dirname, '../../../docs/openapi.json');
const enabled = () => !isProd || process.env.API_DOCS === 'true';

let UI_DIR = null;
try { UI_DIR = require('swagger-ui-dist').getAbsoluteFSPath(); } catch { /* package not installed: only the JSON document is served */ }
const ASSETS = { 'swagger-ui.css': 'text/css; charset=utf-8', 'swagger-ui-bundle.js': 'application/javascript; charset=utf-8', 'swagger-ui-standalone-preset.js': 'application/javascript; charset=utf-8' };

const page = (base) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MediCore API documentation</title>
<link rel="stylesheet" href="${base}/docs/assets/swagger-ui.css">
<style>body{margin:0}.topbar{display:none}</style>
</head><body><div id="swagger-ui"></div>
<script src="${base}/docs/assets/swagger-ui-bundle.js"></script>
<script src="${base}/docs/init.js"></script>
</body></html>
`;
const init = (base) => `window.addEventListener('load', function () {
  window.ui = SwaggerUIBundle({
    url: '${base}/openapi.json', dom_id: '#swagger-ui', deepLinking: true, filter: true, displayRequestDuration: true,
    docExpansion: 'none', defaultModelsExpandDepth: 0, persistAuthorization: false, presets: [SwaggerUIBundle.presets.apis], layout: 'BaseLayout',
  });
});
`;

function docs(req, res, next) {
  const p = req.path.replace(/\/+$/, '') || '/';
  const isSpec = p === '/openapi.json';
  const isUi = p === '/docs' || p.startsWith('/docs/');
  if (!isSpec && !isUi) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next(ApiError.notFound());
  if (!enabled()) return next(ApiError.notFound());
  const base = req.baseUrl || '/api';
  res.set('Cache-Control', 'no-cache');

  if (isSpec) {
    let text;
    try { text = fs.readFileSync(SPEC_FILE, 'utf8'); } catch { return next(ApiError.notFound('The API specification has not been generated (npm run openapi)')); }
    return res.type('application/json').send(text);
  }
  if (!UI_DIR) return next(ApiError.notFound('Swagger UI is not installed'));
  if (p === '/docs') return res.type('html').send(page(base));
  if (p === '/docs/init.js') return res.type('application/javascript').send(init(base));
  const file = p.slice('/docs/assets/'.length);
  if (p.startsWith('/docs/assets/') && ASSETS[file]) { res.set('Content-Type', ASSETS[file]); return fs.createReadStream(path.join(UI_DIR, file)).on('error', next).pipe(res); }
  return next(ApiError.notFound());
}

module.exports = docs;
