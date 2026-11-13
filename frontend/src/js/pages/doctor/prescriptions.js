import { $ } from '../../core/dom.js';
import { initPortal } from '../../core/shell.js';
import { reloadAll } from '../../core/auto.js';
import { openPrescription } from './dialogs.js';

await initPortal({ roles: ['DOCTOR'] });
$('#new-rx').addEventListener('click', () => openPrescription());
document.addEventListener('rx:created', reloadAll);
