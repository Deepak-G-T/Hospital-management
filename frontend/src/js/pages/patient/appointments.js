// Appointments are declared in patient/appointments.html; rescheduling needs the slot picker.
import { api } from '../../core/api.js';
import { $, actions } from '../../core/dom.js';
import { openDialog, closeDialog, withBusy } from '../../core/ui.js';
import { initPortal } from '../../core/shell.js';
import { reloadAll } from '../../core/auto.js';
import { slotPicker } from '../../core/slots.js';
import { formatDateTime } from '../../core/format.js';

await initPortal({ roles: ['PATIENT'] });
const dlg = $('#reschedule-dialog');
const confirmBtn = $('[data-rs-confirm]', dlg);
const selected = $('[data-slot-selected]', dlg);

actions($('#appts'), {
  reschedule(a) {
    dlg.querySelector('p').textContent = `Dr. ${a.doctor.fullName} · currently ${formatDateTime(a.startAt)}`;
    const picker = slotPicker($('[data-slot-picker]', dlg), a.doctor.id, {
      exclude: a.id,
      onChange: (v) => { confirmBtn.disabled = !v; selected.hidden = !v; if (v) $('strong', selected).textContent = formatDateTime(v); },
    });
    confirmBtn.onclick = async () => {
      if (await withBusy(confirmBtn, () => api.patch(`/patient/appointments/${a.id}/reschedule`, { startAt: picker.value }), 'Rescheduled — awaiting doctor confirmation')) {
        closeDialog(dlg); reloadAll();
      }
    };
    openDialog(dlg);
  },
});
