// Complaints are declared in portal/complaints.html
import { $ } from '../../core/dom.js';
import { initPortal } from '../../core/shell.js';

const { user } = await initPortal({ roles: ['DOCTOR', 'PATIENT'] });
const form = $('#complaint-form');
// the doctor field only counts for "Doctor" complaints (CSS hides it otherwise); doctors can't pick themselves
form.transform = (v) => ({ ...v, againstDoctorId: v.category === 'DOCTOR' ? v.againstDoctorId || null : null });
form.againstDoctorId.addEventListener('focus', () => { [...form.againstDoctorId.options].find((o) => o.value === user.profile?.id)?.remove(); });
