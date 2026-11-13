// Admin patients: everything is declared in the HTML except this guard for the edit form.
import { $, itemOf } from '../../core/dom.js';
import { initPortal } from '../../core/shell.js';

await initPortal({ roles: ['ADMIN'] });

// The edit form must never overwrite stored data with a blank or missing value: it sends only the fields the admin
// actually changed (and only with a value). Registration (no id yet) sends everything that was entered, blood group included.
const form = $('#patient-form');
form.transform = (values) => {
  const patient = itemOf(form) || {};
  if (!patient.id) return values;
  const stored = {
    fullName: patient.fullName, email: patient.user?.email, phone: patient.phone, dateOfBirth: patient.dateOfBirth?.slice(0, 10),
    gender: patient.gender, address: patient.address, emergencyContactName: patient.emergencyContactName, emergencyContactPhone: patient.emergencyContactPhone,
  };
  const changed = {};
  for (const [key, was] of Object.entries(stored)) {
    const now = String(values[key] ?? '').trim();
    if (now !== '' && now !== (was ?? '')) changed[key] = now;
  }
  return changed;
};
