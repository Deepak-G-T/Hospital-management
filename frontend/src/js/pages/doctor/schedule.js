import { api } from '../../core/api.js';
import { $, $$, load } from '../../core/dom.js';
import { toast, withBusy } from '../../core/ui.js';
import { initPortal } from '../../core/shell.js';
import { DAY_NAMES } from '../../core/format.js';

await initPortal({ roles: ['DOCTOR'] });
const box = $('#schedule');
const daysEl = $('#days');
const settings = $('#settings');

function blockEl(b = { startTime: '09:00', endTime: '13:00' }) {
  const el = $('#tpl-block').content.firstElementChild.cloneNode(true);
  $('[data-start]', el).value = b.startTime;
  $('[data-end]', el).value = b.endTime;
  return el;
}
const count = (row) => { const n = $('[data-blocks]', row).children.length; $('[data-day-count]', row).textContent = n ? `${n} block(s)` : 'Not working'; $('[data-copy]', row).hidden = !n; };

function build(availability) {
  daysEl.replaceChildren(...DAY_NAMES.map((name, day) => {
    const row = $('#tpl-day').content.firstElementChild.cloneNode(true);
    row.dataset.day = day;
    $('[data-text="name"]', row).textContent = name;
    availability.filter((a) => a.dayOfWeek === day).forEach((a) => $('[data-blocks]', row).append(blockEl(a)));
    count(row);
    return row;
  }));
}
daysEl.addEventListener('click', (e) => {
  const row = e.target.closest('.day-row');
  if (!row) return;
  if (e.target.closest('[data-add]')) { $('[data-blocks]', row).append(blockEl()); count(row); }
  if (e.target.closest('[data-remove]')) { e.target.closest('.block').remove(); count(row); }
  if (e.target.closest('[data-copy]')) {
    const blocks = $$('.block', row).map((b) => b.cloneNode(true));
    $$('.day-row', daysEl).filter((r) => [1, 2, 3, 4, 5].includes(Number(r.dataset.day))).forEach((r) => {
      const values = $$('.block', row).map((b) => [$('[data-start]', b).value, $('[data-end]', b).value]);
      $('[data-blocks]', r).replaceChildren(...values.map(([startTime, endTime]) => blockEl({ startTime, endTime })));
      count(r);
    });
    toast(`Copied ${DAY_NAMES[row.dataset.day]} to Mon–Fri (${blocks.length} block(s))`, 'success');
  }
});

const show = () => load(box, () => api.get('/doctor/profile'), { isEmpty: () => false }).then((p) => {
  settings.slotDurationMinutes.value = String(p.slotDurationMinutes);
  settings.isAvailableForEmergency.checked = p.isAvailableForEmergency;
  build(p.availability);
}).catch(() => {});

$('#save').addEventListener('click', (e) => {
  const slots = $$('.day-row', daysEl).flatMap((row) => $$('.block', row).map((b) => ({ dayOfWeek: Number(row.dataset.day), startTime: $('[data-start]', b).value, endTime: $('[data-end]', b).value })));
  if (slots.some((s) => !s.startTime || !s.endTime || s.endTime <= s.startTime)) { toast('Each block must end after it starts', 'error'); return; }
  withBusy(e.currentTarget, async () => {
    await api.put('/doctor/availability', { slots });
    await api.put('/doctor/profile', { slotDurationMinutes: Number(settings.slotDurationMinutes.value), isAvailableForEmergency: settings.isAvailableForEmergency.checked });
  }, 'Schedule saved — patients now see your new availability');
});
show();
