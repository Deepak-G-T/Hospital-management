import { defineConfig } from 'vite';
import { resolve, dirname, relative } from 'node:path';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const partialsDir = resolve(root, 'partials');

// Every .html page is a build entry (partials and build output excluded)
function htmlPages(dir = root) {
  return readdirSync(dir).flatMap((name) => {
    const full = resolve(dir, name);
    if (['node_modules', 'dist', 'partials', 'tests', 'public', 'src'].includes(name)) return [];
    if (statSync(full).isDirectory()) return htmlPages(full);
    return name.endsWith('.html') ? [full] : [];
  });
}

// <!-- @include file.html --> is replaced by partials/file.html (nested includes allowed)
function includePartials(html, depth = 0) {
  if (depth > 5) throw new Error('Partial include depth exceeded');
  return html.replace(/<!--\s*@include\s+([\w./-]+)\s*-->/g, (_, file) => includePartials(readFileSync(resolve(partialsDir, file), 'utf8'), depth + 1));
}

// Clean URLs (same addresses as before): /admin/doctors -> admin/doctors.html, /admin -> admin/index.html
// Shared portal pages and pages with an id in the address map to one HTML file each.
const ROUTES = [
  [/^\/(doctor|patient)\/(notifications|complaints)$/, (m) => `/portal/${m[2]}.html`],
  [/^\/(admin|doctor|patient)\/settings$/, () => '/portal/settings.html'],
  [/^\/doctors\/[\w-]+$/, () => '/doctors/profile.html'],
  [/^\/patient\/doctors\/[\w-]+$/, () => '/patient/doctor.html'],
  [/^\/doctor\/patients\/[\w-]+$/, () => '/doctor/patient.html'],
];

export function resolveRoute(pathname) {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (p === '/') return '/index.html';
  for (const [re, to] of ROUTES) { const m = p.match(re); if (m) return to(m); }
  if (existsSync(resolve(root, `.${p}.html`))) return `${p}.html`;
  if (existsSync(resolve(root, `.${p}`, 'index.html'))) return `${p}/index.html`;
  return '/404.html';
}

const cleanUrls = (skip) => (req, res, next) => {
  const [path, query] = req.url.split('?');
  if (skip.test(path) || /\.\w+$/.test(path)) return next(); // API, sockets, Vite internals, real files
  req.url = resolveRoute(path) + (query ? `?${query}` : '');
  return next();
};

const proxy = {
  '/api': { target: 'http://localhost:5000', changeOrigin: true },
  '/socket.io': { target: 'http://localhost:5000', ws: true },
};

export default defineConfig({
  appType: 'mpa',
  plugins: [{
    name: 'medicore-html',
    configureServer(server) {
      server.middlewares.use(cleanUrls(/^\/(@|(api|socket\.io|src|node_modules)(\/|$))/));
      server.watcher.add(partialsDir);
      server.watcher.on('change', (f) => { if (f.startsWith(partialsDir)) server.ws.send({ type: 'full-reload' }); });
    },
    configurePreviewServer(server) {
      server.middlewares.use(cleanUrls(/^\/(api|socket\.io)(\/|$)/));
    },
    transformIndexHtml: { order: 'pre', handler: (html) => includePartials(html) },
  }],
  build: {
    target: 'es2022', // page scripts use top-level await
    rollupOptions: { input: Object.fromEntries(htmlPages().map((f) => [relative(root, f).replace(/\.html$/, ''), f])) },
  },
  server: { port: 5173, proxy },
  preview: { proxy },
});
