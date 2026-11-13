// Doctor profile (partials/doctor-profile.html): loaded and filled from HTML; this groups opening hours and adds booking
import { $, actions } from '../../core/dom.js';
import { source } from '../../core/auto.js';
import { DAY_NAMES, formatTimeStr } from '../../core/format.js';
import { openBooking } from '../../core/booking.js';

export function doctorProfile({ backHref = '/doctors', backLabel = 'Back to doctors' } = {}) {
  const back = $('[data-back]');
  back.href = backHref;
  back.lastChild.textContent = backLabel;
  source('#profile', {
    map: (d) => ({ ...d, hours: DAY_NAMES.map((day, i) => ({ day, times: d.availability.filter((a) => a.dayOfWeek === i).map((a) => `${formatTimeStr(a.startTime)}–${formatTimeStr(a.endTime)}`).join(', ') || 'Closed' })) }),
    after: (d) => { document.title = `Dr. ${d.fullName} · MediCore`; },
  });
  actions($('#profile'), { book: (d) => openBooking(d, { returnTo: location.pathname }) });
}
