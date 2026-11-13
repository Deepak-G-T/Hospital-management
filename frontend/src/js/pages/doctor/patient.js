import { $, actions } from '../../core/dom.js';
import { initPortal } from '../../core/shell.js';
import { source, reloadAll } from '../../core/auto.js';
import { openPrescription } from './dialogs.js';

await initPortal({ roles: ['DOCTOR'] });
source('#record', { after: (p) => { document.title = `${p.fullName} · MediCore`; } });
actions($('#record'), { rx: (patient) => openPrescription({ patient }) });
document.addEventListener('rx:created', reloadAll);
