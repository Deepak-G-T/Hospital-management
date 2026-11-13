import { $, actions } from '../../core/dom.js';
import { initPortal } from '../../core/shell.js';
import { openPrescription } from './dialogs.js';

await initPortal({ roles: ['DOCTOR'] });
actions($('#appts'), { prescribe: (a) => openPrescription({ patient: a.patient, appointment: a }) });
