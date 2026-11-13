// Doctor cards (partials/tpl-doctor-card.html) are declared in HTML; this adds the Book button
import { $, actions } from '../../core/dom.js';
import { openBooking } from '../../core/booking.js';

export function directory(root = '#directory [data-results]') {
  actions($(root), { book: (d) => openBooking(d, { returnTo: new URL(`doctors/${d.id}`, location.href).pathname }) });
}
