// Clinical dialogs (partials/dialogs/doctor-dialogs.html). Consultation notes are fully declarative;
// the prescription builder and the referral department picker need a little script.
import { api } from '../../core/api.js';
import { $, $$, options, formValues, itemOf } from '../../core/dom.js';
import { openDialog, closeDialog, withBusy, toast } from '../../core/ui.js';
import { enumLabel, formatDateTime } from '../../core/format.js';

/* ---------- Referral: departments follow the chosen colleague ---------- */
const ref = $('#referral-form');
if (ref) {
  ref.toDoctorId.addEventListener('change', () => {
    const depts = (ref.toDoctorId.items || []).find((c) => c.id === ref.toDoctorId.value)?.departments.map((d) => d.department) || [];
    options(ref.departmentId, depts);
    ref.departmentId.closest('.field').hidden = !depts.length;
  });
  ref.transform = (v) => ({ ...v, patientId: v.patientId || itemOf(ref).id });
  ref.closest('dialog').addEventListener('dialog:open', () => { ref.departmentId.closest('.field').hidden = true; });
}

/* ---------- Prescription ---------- */
export function openPrescription({ patient, appointment } = {}) {
  const form = $('#rx-form');
  form.reset();
  const meds = $('[data-meds]', form);
  const addMed = () => { meds.append($('#tpl-med-row').content.firstElementChild.cloneNode(true)); syncRemove(); };
  const syncRemove = () => $$('[data-remove-med]', meds).forEach((b) => { b.disabled = meds.children.length === 1; });
  meds.replaceChildren();
  addMed();
  $('[data-add-med]', form).onclick = addMed;
  meds.onclick = (e) => { const b = e.target.closest('[data-remove-med]'); if (b && !b.disabled) { b.closest('.med-row').remove(); syncRemove(); } };
  form.followUpDate.min = new Date().toISOString().slice(0, 10);
  if (appointment?.diagnosis) form.diagnosis.value = appointment.diagnosis;

  const allergyBox = $('[data-rx-allergies]', form);
  const loadPatient = async (id) => {
    allergyBox.hidden = true;
    options(form.appointmentId, [], { keep: 1 });
    const p = id && await api.get(`/doctor/patients/${id}`).catch(() => null);
    const submit = form.querySelector('[type=submit]');
    if (submit) submit.disabled = Boolean(p) && p.access?.canWrite === false;
    if (p && p.access?.canWrite === false) toast('You can only prescribe to patients you are currently treating (an active appointment, emergency or referral).', 'error');
    if (!p) return;
    $('[data-rx-allergy-text]', form).textContent = p.allergies.map((a) => `${a.allergen} (${enumLabel(a.type)}, ${enumLabel(a.severity)})`).join(', ');
    allergyBox.hidden = !p.allergies.length;
    const appts = p.appointments.filter((a) => ['CONFIRMED', 'COMPLETED'].includes(a.status));
    if (appointment && !appts.some((a) => a.id === appointment.id)) appts.unshift(appointment);
    options(form.appointmentId, appts, { label: (a) => `${formatDateTime(a.startAt)} · ${enumLabel(a.status)}` });
    if (appointment) form.appointmentId.value = appointment.id;
  };

  $('[data-rx-patient-field]', form).hidden = Boolean(patient);
  $('[data-rx-sub]', form).textContent = patient ? patient.fullName : 'Choose a patient';
  if (patient) loadPatient(patient.id);
  else {
    api.all('/doctor/patients', { treating: 'true' }).then((list) => options(form.patientId, list, { label: 'fullName' })).catch(() => {});
    form.patientId.onchange = () => loadPatient(form.patientId.value);
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const patientId = patient?.id || form.patientId.value;
    if (!patientId) { toast('Select a patient', 'error'); return; }
    if (!form.diagnosis.value.trim() || ![...meds.querySelectorAll('input[required]')].every((i) => i.reportValidity())) { form.diagnosis.reportValidity(); return; }
    const v = formValues(form);
    const items = $$('.med-row', meds).map((row) => ({ ...formValues({ elements: $$('input', row) }), durationDays: Number($('[name=durationDays]', row).value) }));
    const rx = await withBusy(form.querySelector('[type=submit]'), () => api.post('/doctor/prescriptions', {
      patientId, appointmentId: v.appointmentId || null, diagnosis: v.diagnosis, advice: v.advice, followUpDate: v.followUpDate || null, items,
    }), (r) => `Prescription ${r.prescriptionNumber} issued — the patient was notified`);
    if (rx) { closeDialog('rx-dialog'); document.dispatchEvent(new Event('rx:created')); }
  };
  openDialog('rx-dialog');
}
