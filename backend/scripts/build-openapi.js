/* eslint-disable no-console */
// Builds docs/openapi.json (OpenAPI 3.1) from the running router, the zod validators and src/openapi/*.js.
// Run: node scripts/build-openapi.js --write      (prints a summary without --write)
// tests/openapi.test.js fails when the file is out of date, so a new or changed endpoint cannot ship undocumented.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { inventory } = require('./list-api-routes');
const { build } = require('../src/openapi/build');

const FILE = path.join(__dirname, '../../docs/openapi.json');
const render = (routes) => `${JSON.stringify(build(routes), null, 2)}\n`;
module.exports = { render, FILE };

if (require.main === module) {
  const routes = inventory();
  const text = render(routes);
  const spec = JSON.parse(text);
  const ops = Object.values(spec.paths).reduce((n, p) => n + Object.keys(p).length, 0);
  if (process.argv.includes('--write')) { fs.writeFileSync(FILE, text); console.log(`written docs/openapi.json: ${ops} operations of ${routes.length} routes, ${Object.keys(spec.components.schemas).length} schemas, ${(text.length / 1024).toFixed(0)} KB`); } else console.log(`${ops} operations of ${routes.length} routes`);
  process.exit(0);
}
