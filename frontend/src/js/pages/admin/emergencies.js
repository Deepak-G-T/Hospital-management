import { $, bind, itemOf } from '../../core/dom.js';
import { stats } from '../../core/ui.js';
import { initPortal } from '../../core/shell.js';
import { source } from '../../core/auto.js';

await initPortal({ roles: ['ADMIN'] });
document.documentElement.classList.remove('has-emergency');
const dlg = $('#em-dialog');
let revealed = null; // medical details the admin opened with a reason stay visible while the dialog is open
dlg.addEventListener('close', () => { revealed = null; });
const view = (e) => ({
  ...e,
  responseMin: e.acceptedAt ? Math.max(0, Math.round((new Date(e.acceptedAt) - new Date(e.createdAt)) / 60000)) : null,
  // once per automatic-escalation level, only while nobody has accepted
  hasAutoEscalation: e.autoEscalationLevel > 0 || Boolean(e.nextEscalationAt || e.acknowledgedAt),
  canAcknowledge: ['PENDING', 'NOTIFIED', 'ESCALATED'].includes(e.status) && !e.assignedDoctorId && e.acknowledgedLevel !== e.autoEscalationLevel,
});

source('#list', {
  map: view,
  after(res) {
    stats($('#counts'), res.items.reduce((a, e) => ({ ...a, [e.priority]: a[e.priority] + 1 }), { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }));
    const fresh = dlg.open && res.items.find((x) => x.id === itemOf(dlg)?.id); // keep an open case up to date
    if (fresh) bind(dlg, view(revealed?.id === fresh.id ? { ...fresh, patient: { ...fresh.patient, allergies: revealed.allergies, clinicalWithheld: false } } : fresh));
  },
});
// send only what the admin changed
$('#admin-form').transform = (v) => {
  const e = itemOf(dlg);
  return {
    ...(v.priority !== e.priority ? { priority: v.priority } : {}),
    ...(v.departmentId && v.departmentId !== e.departmentId ? { departmentId: v.departmentId } : {}),
    ...(v.assignDoctorId ? { assignDoctorId: v.assignDoctorId } : {}),
  };
};
dlg.addEventListener('api:done', (e) => {
  const r = e.detail.result;
  if (!r?.id) return;
  if (r.patient && r.patient.clinicalWithheld === false) revealed = { id: r.id, allergies: r.patient.allergies };
  bind(dlg, view(r));
});
