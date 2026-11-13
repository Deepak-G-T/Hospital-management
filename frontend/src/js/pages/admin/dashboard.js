import { $, bind } from '../../core/dom.js';
import { initPortal } from '../../core/shell.js';
import { source } from '../../core/auto.js';

await initPortal({ roles: ['ADMIN'] });
// everything is declared in admin/index.html; the hero banner sits outside the loaded block
source('#body', { after: (d) => bind($('#dash [data-block]'), d) });
