// The tracker, history, request form and cancel button are declared in patient/emergency.html.
// This adds progress steps, the response time, the phone prefill and the optional location capture.
import { $ } from '../../core/dom.js';
import { toast } from '../../core/ui.js';
import { initPortal } from '../../core/shell.js';
import { source } from '../../core/auto.js';

const { user } = await initPortal({ roles: ['PATIENT'] });
document.documentElement.classList.remove('has-emergency');
const form = $('#em-form');

const progress = (e) => (e.status === 'RESOLVED' ? 5 : e.status === 'ACCEPTED' ? 4 : ['NOTIFIED', 'ESCALATED'].includes(e.status) ? 3 : e.departmentId ? 2 : 1);
source('#em', { map: (e) => ({ ...e, progress: progress(e) }) });
source('#em-history', { map: (e) => ({ ...e, responseMin: e.acceptedAt ? Math.max(0, Math.round((new Date(e.acceptedAt) - new Date(e.createdAt)) / 60000)) : null }) });

form.contactPhone.value = user.profile?.phone || '';
const locate = $('[data-locate]', form);
const coords = $('[data-coords]', form);
let position = null;
form.locationConsent.addEventListener('change', () => {
  locate.disabled = !form.locationConsent.checked;
  if (!form.locationConsent.checked) { position = null; coords.hidden = true; }
});
locate.addEventListener('click', () => {
  if (!navigator.geolocation) { toast('Location is not supported by this browser', 'error'); return; }
  locate.setAttribute('aria-busy', 'true');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      position = { latitude: Number(pos.coords.latitude.toFixed(6)), longitude: Number(pos.coords.longitude.toFixed(6)) };
      $('span', coords).textContent = `${position.latitude}, ${position.longitude}`;
      coords.hidden = false; locate.removeAttribute('aria-busy'); toast('Location captured', 'success');
    },
    () => { locate.removeAttribute('aria-busy'); toast('Could not get your location. You can type your address instead.', 'error'); },
    { enableHighAccuracy: true, timeout: 10000 },
  );
});
// coordinates are only sent with consent
form.transform = (v) => ({ ...v, latitude: v.locationConsent ? position?.latitude ?? null : null, longitude: v.locationConsent ? position?.longitude ?? null : null });
