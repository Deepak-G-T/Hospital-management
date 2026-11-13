// Slot picker: next 21 days + the doctor's free times for the chosen day.
import { api } from './api.js';
import { $, setState } from './dom.js';
import { addDays, toDateInput, DAY_SHORT, formatDateTime } from './format.js';

export function slotPicker(root, doctorId, { exclude, onChange } = {}) {
  const daysEl = $('[data-days]', root);
  const state = $('[data-slots-state]', root);
  const slotsEl = $('[data-slots]', root);
  let value = null;
  const set = (v) => {
    value = v;
    slotsEl.querySelectorAll('.slot').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v)));
    onChange?.(v);
  };

  async function loadDay(date) {
    set(null);
    daysEl.querySelectorAll('.day').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.date === date)));
    setState(state, 'loading');
    try {
      const { slots } = await api.get(`/public/doctors/${doctorId}/slots`, { date, exclude });
      const free = slots.filter((s) => s.available);
      $('[data-slots-empty]', root).textContent = !slots.length
        ? 'The doctor is not available on this day. Try another date.'
        : 'All slots are booked for this day.';
      if (!free.length) { setState(state, 'empty'); return; }
      slotsEl.replaceChildren(...slots.map((s) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'slot';
        b.dataset.value = new Date(s.startAt).toISOString();
        b.disabled = !s.available;
        b.title = s.booked ? 'Already booked' : !s.available ? 'In the past' : 'Available';
        b.textContent = new Date(s.startAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        b.addEventListener('click', () => set(b.dataset.value));
        return b;
      }));
      setState(state, 'ready');
    } catch (err) { setState(state, 'error', err.message); }
  }

  daysEl.replaceChildren(...Array.from({ length: 21 }, (_, i) => {
    const d = addDays(new Date(), i);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'day'; b.dataset.date = toDateInput(d);
    b.innerHTML = `<small>${DAY_SHORT[d.getDay()]}</small><strong>${d.getDate()}</strong><small>${d.toLocaleDateString('en-US', { month: 'short' })}</small>`;
    b.addEventListener('click', () => loadDay(b.dataset.date));
    return b;
  }));
  loadDay(toDateInput());
  return { get value() { return value; }, describe: (v) => formatDateTime(v) };
}
