// Date range filter (partials/date-range-fields.html): presets + custom from/to.
// <div data-range data-days="30"> works as a filter: its inputs are named from/to and it fires "change".
import { $, $$ } from './dom.js';
import { toDateInput, addDays } from './format.js';

export const rangeFor = (days) => ({ from: toDateInput(addDays(new Date(), -(days - 1))), to: toDateInput() });

export function dateRange(root, days, onChange) {
  if (!root.range) {
    const from = $('[name=from]', root);
    const to = $('[name=to]', root);
    const presets = $$('[data-presets] [data-value]', root);
    const set = (r, fire) => {
      from.value = r.from;
      to.value = r.to;
      const today = toDateInput();
      presets.forEach((b) => b.setAttribute('aria-selected', String(to.value === today && from.value === rangeFor(Number(b.dataset.value)).from)));
      from.max = to.value;
      to.min = from.value;
      if (fire) root.dispatchEvent(new CustomEvent('range', { detail: root.range.value }));
    };
    presets.forEach((b) => {
      b.type = 'button';
      b.addEventListener('click', () => { set(rangeFor(Number(b.dataset.value)), true); root.dispatchEvent(new Event('change', { bubbles: true })); });
    });
    [from, to].forEach((i) => i.addEventListener('change', () => { if (from.value && to.value) set({ from: from.value, to: to.value }, true); }));
    root.range = { get value() { return { from: from.value, to: to.value }; } };
    set(rangeFor(days || Number(root.dataset.days) || 30), false);
  }
  if (onChange) root.addEventListener('range', (e) => onChange(e.detail));
  return root.range;
}
