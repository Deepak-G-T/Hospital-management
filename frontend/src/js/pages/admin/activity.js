import { $, render } from '../../core/dom.js';
import { initPortal } from '../../core/shell.js';
import { source } from '../../core/auto.js';

await initPortal({ roles: ['ADMIN'] });
source('#body', {
  isEmpty: () => false, // the chart stays visible even when the table is empty
  after(d) {
    render($('[data-most-active]'), 'tpl-active', d.mostActive);
    $('[data-no-active]').hidden = d.mostActive.length > 0;
    $('[data-no-rows]').hidden = d.items.length > 0;
  },
});
