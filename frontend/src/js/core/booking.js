// Booking dialog (partials/dialogs/booking.html). Guests are sent to login, non-patients get a message.
import { api, getToken } from './api.js';
import { $, bind, options, formValues } from './dom.js';
import { openDialog, closeDialog, toast, withBusy } from './ui.js';
import { slotPicker } from './slots.js';

function storedRole() { try { return localStorage.getItem('medicore_role'); } catch { return null; } }

export function openBooking(doctor, { returnTo } = {}) {
  if (!getToken()) {
    toast('Please log in or register to book an appointment');
    location.href = `/login?next=${encodeURIComponent(returnTo || `/doctors/${doctor.id}`)}`;
    return;
  }
  if (storedRole() !== 'PATIENT') { toast('Only patient accounts can book appointments', 'error'); return; }

  const dlg = $('#booking-dialog');
  const form = $('#booking-form');
  form.reset();
  bind(dlg, doctor);
  const depts = doctor.departments || [];
  $('[data-booking-dept]', dlg).hidden = depts.length < 2;
  options($('#bk-dept'), depts.map((d) => d.department), { keep: 0 });
  $('#bk-dept').value = (depts.find((d) => d.isPrimary) || depts[0])?.department.id || '';

  const submit = $('[data-booking-submit]', dlg);
  const selected = $('[data-slot-selected]', dlg);
  const picker = slotPicker($('[data-slot-picker]', dlg), doctor.id, {
    onChange: (v) => {
      submit.disabled = !v;
      selected.hidden = !v;
      if (v) $('strong', selected).textContent = picker.describe(v);
    },
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!picker.value) { toast('Please choose a time slot', 'error'); return; }
    const v = formValues(form);
    const ok = await withBusy(submit, () => api.post('/patient/appointments', {
      doctorId: doctor.id, departmentId: v.departmentId || null, startAt: picker.value, reason: v.reason, type: v.type,
    }), 'Appointment requested! The doctor will confirm shortly.');
    if (ok) { closeDialog(dlg); location.href = '/patient/appointments'; }
  };
  openDialog(dlg);
}
