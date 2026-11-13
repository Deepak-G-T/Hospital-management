import { $ } from '../../core/dom.js';
import { initPortal } from '../../core/shell.js';
import { source } from '../../core/auto.js';
import { enumLabel } from '../../core/format.js';

await initPortal({ roles: ['ADMIN'] });
const select = $('#filters [name=action]');
// the response also lists every action type: fill the filter once
source('#list', { after: (r) => { if (select.options.length === 1) r.actions.forEach((a) => select.add(new Option(enumLabel(a), a))); } });
