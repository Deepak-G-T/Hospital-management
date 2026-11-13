// Entry for portal pages that need no script of their own: <body data-roles="ADMIN"> … everything else is declared in the HTML.
import { initPortal } from './core/shell.js';

initPortal({ roles: document.body.dataset.roles?.split(',') });
