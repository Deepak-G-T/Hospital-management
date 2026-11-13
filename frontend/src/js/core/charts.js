// Charts drawn with HTML/CSS (bars, donuts) and a small SVG (lines). Styling lives in tables-charts.css;
// colours are CSS custom properties (--series-n), so charts follow light/dark mode automatically.
import { shortDate, enumLabel, FORMATS } from './format.js';
import { getPath } from './dom.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const color = (i) => `var(--series-${(i % 8) + 1})`;
export const PRIORITY_COLORS = { CRITICAL: 'var(--status-critical)', HIGH: 'var(--status-serious)', MEDIUM: 'var(--status-warning)', LOW: 'var(--series-1)' };
const isPhone = () => window.matchMedia('(max-width: 639px)').matches;
const niceMax = (v) => { if (v <= 4) return 4; const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
const hasData = (data, keys) => data?.some((d) => keys.some((k) => Number(d[k]) > 0));

function noData(el, h) {
  el.innerHTML = `<div class="no-data" style="--h:${h}px"><svg class="icon icon-xl soft"><use href="#i-bar-chart-3"/></svg>No data for the selected filters</div>`;
}
const legend = (series) => `<ul class="legend">${series.map((s, i) => `<li style="--c:${s.color || color(i)}"><i></i>${esc(s.name)}</li>`).join('')}</ul>`;

/* ---------- Line / area chart over time ---------- */
export function lineChart(el, data, series, { height = 280, area = false, xKey = 'date', fmt = shortDate } = {}) {
  const draw = () => {
    const h = isPhone() ? Math.min(height, 220) : height;
    if (!hasData(data, series.map((s) => s.key))) { noData(el, h); return; }
    const w = Math.max(el.clientWidth, 280);
    const pad = { l: isPhone() ? 30 : 38, r: 8, t: 8, b: 24 };
    const pw = w - pad.l - pad.r; const ph = h - pad.t - pad.b;
    const max = niceMax(Math.max(...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0))));
    const x = (i) => pad.l + (data.length === 1 ? pw / 2 : (i * pw) / (data.length - 1));
    const y = (v) => pad.t + ph - ((Number(v) || 0) / max) * ph;
    const curve = (key) => data.map((d, i) => {
      if (i === 0) return `M${x(0)},${y(d[key])}`;
      const mx = (x(i - 1) + x(i)) / 2;
      return `C${mx},${y(data[i - 1][key])} ${mx},${y(d[key])} ${x(i)},${y(d[key])}`;
    }).join(' ');
    const ticks = [0, 1, 2, 3, 4].map((k) => (max / 4) * k);
    const step = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(pw / (isPhone() ? 70 : 64)))));
    const gid = `g${Math.random().toString(36).slice(2, 8)}`;
    el.innerHTML = `
      <svg class="line-chart" style="--h:${h}px" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(series.map((s) => s.name).join(', '))} over time">
        <defs>${series.map((s, i) => `<linearGradient id="${gid}${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" style="stop-color:${color(i)};stop-opacity:${area || i === 0 ? 0.28 : 0.08}"/><stop offset="100%" style="stop-color:${color(i)};stop-opacity:0"/></linearGradient>`).join('')}</defs>
        ${ticks.map((t) => `<line class="grid-line" x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis-text" x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${Math.round(t)}</text>`).join('')}
        ${data.map((d, i) => (i % step === 0 ? `<text class="axis-text" x="${x(i)}" y="${h - 6}" text-anchor="middle">${esc(fmt(d[xKey]))}</text>` : '')).join('')}
        ${series.map((s, i) => `<path class="series-area" d="${curve(s.key)} L${x(data.length - 1)},${pad.t + ph} L${x(0)},${pad.t + ph} Z" style="fill:url(#${gid}${i})"/>`).join('')}
        ${series.map((s, i) => `<path class="series-line" d="${curve(s.key)}" style="stroke:${color(i)}"/>`).join('')}
        <line class="guide" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ph}"/>
        ${series.map((s, i) => `<circle class="dot" r="5" style="fill:${color(i)}" data-series="${i}"/>`).join('')}
      </svg>
      <div class="chart-tip" aria-hidden="true"></div>
      ${series.length > 1 ? legend(series) : ''}`;
    const svg = el.querySelector('svg');
    svg.querySelectorAll('.series-line').forEach((p) => p.style.setProperty('--len', p.getTotalLength()));
    const tip = el.querySelector('.chart-tip');
    const guide = svg.querySelector('.guide');
    const dots = [...svg.querySelectorAll('.dot')];
    const move = (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * w;
      const i = Math.max(0, Math.min(data.length - 1, Math.round(((px - pad.l) / pw) * (data.length - 1))));
      const d = data[i];
      svg.classList.add('is-hover');
      guide.setAttribute('x1', x(i)); guide.setAttribute('x2', x(i));
      dots.forEach((dot, k) => { dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(d[series[k].key])); });
      tip.innerHTML = `<strong>${esc(fmt(d[xKey]))}</strong>${series.map((s, k) => `<div style="--c:${color(k)}"><i></i>${esc(s.name)}<b>${d[s.key] ?? 0}</b></div>`).join('')}`;
      const left = (x(i) / w) * r.width;
      tip.style.left = `${Math.min(Math.max(left - 70, 0), r.width - 150)}px`;
      tip.style.top = '0px';
      tip.classList.add('is-visible');
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerleave', () => { svg.classList.remove('is-hover'); tip.classList.remove('is-visible'); });
  };
  draw();
  if (!el.dataset.observed) {
    el.dataset.observed = '1';
    let lastW = el.clientWidth;
    new ResizeObserver(() => { if (Math.abs(el.clientWidth - lastW) > 24) { lastW = el.clientWidth; draw(); } }).observe(el);
  }
}

/* ---------- Vertical grouped bars ---------- */
export function barChart(el, data, series, { xKey = 'name', height = 280 } = {}) {
  const h = isPhone() ? Math.min(height, 240) : height;
  if (!hasData(data, series.map((s) => s.key))) { noData(el, h); return; }
  const max = niceMax(Math.max(...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0))));
  const crowded = data.length > (isPhone() ? 4 : 6);
  const ticks = [0, 1, 2, 3, 4].map((k) => Math.round((max / 4) * k));
  el.innerHTML = `
    <div class="vbars ${crowded ? 'is-crowded' : ''}" style="--h:${h}px" role="img" aria-label="${esc(series.map((s) => s.name).join(', '))} by ${esc(xKey)}">
      <div class="vbars-y">${ticks.map((t) => `<span>${t}</span>`).join('')}</div>
      <div class="vbars-plot">${data.map((d) => `
        <div class="vbars-group">
          ${series.map((s, i) => `<div class="vbar" style="--h:${((Number(d[s.key]) || 0) / max) * 100};--c:${color(i)}" data-tip="${esc(d[xKey])} · ${esc(s.name)}: ${d[s.key] ?? 0}"></div>`).join('')}
          <small title="${esc(d[xKey])}">${esc(d[xKey])}</small>
        </div>`).join('')}
      </div>
    </div>${series.length > 1 ? legend(series) : ''}`;
}

/* ---------- Horizontal (stacked) bars — long category names ---------- */
export function hbarChart(el, data, series, { labelKey = 'name' } = {}) {
  if (!hasData(data, series.map((s) => s.key))) { noData(el, 200); return; }
  const max = niceMax(Math.max(...data.map((d) => series.reduce((sum, s) => sum + (Number(d[s.key]) || 0), 0))));
  el.innerHTML = `<div class="hbars" role="img" aria-label="${esc(series.map((s) => s.name).join(' and '))} per ${esc(labelKey)}">${data.map((d) => `
    <div class="hbar-row"><span title="${esc(d[labelKey])}">${esc(d[labelKey])}</span>
      <div class="hbar-track">${series.map((s, i) => `<div class="hbar-seg" style="--w:${((Number(d[s.key]) || 0) / max) * 100};--c:${color(i)}" data-tip="${esc(s.name)}: ${d[s.key] ?? 0}"></div>`).join('')}</div>
    </div>`).join('')}</div>${legend(series)}`;
}

/* ---------- Donut / pie ---------- */
export function donut(el, data, { colors, center = 'Total', pie = false } = {}) {
  const items = (data || []).map((d, i) => ({ key: d.name, name: d.label || enumLabel(d.name), value: Number(d.value) || 0, c: colors?.[d.name] || color(i) })).filter((d) => d.value > 0);
  if (!items.length) { noData(el, 220); return; }
  const total = items.reduce((s, d) => s + d.value, 0);
  let acc = 0;
  const stops = items.map((d) => { const a = (acc / total) * 360; acc += d.value; return `${d.c} ${a}deg ${(acc / total) * 360}deg`; }).join(', ');
  el.innerHTML = `
    <div class="donut-wrap">
      <div class="donut-box">
        <div class="donut ${pie ? 'is-pie' : ''}" style="--g:conic-gradient(${stops})" role="img" aria-label="${esc(items.map((d) => `${d.name} ${d.value}`).join(', '))}"></div>
        ${pie ? '' : `<div class="donut-center"><strong>${total}</strong><small>${esc(center)}</small></div>`}
      </div>
      <ul class="legend">${items.map((d) => `<li style="--c:${d.c}"><i></i>${esc(d.name)} <b>${d.value}</b></li>`).join('')}</ul>
    </div>`;
}

/* ---------- Accessible table view for any chart ---------- */
export function chartTable(el, columns, rows) {
  el.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr>${columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td class="tnum" data-label="${esc(c.label)}">${esc(c.format ? c.format(r[c.key]) : r[c.key] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/**
 * Charts declared in HTML, drawn from loaded data:
 * <div data-chart="key" data-kind="line|bar|hbar|donut" data-rows="path" data-series="key:Name,…" data-columns="key:Label[:format],…"
 *      [data-height] [data-area] [data-center] [data-colors="priority"] [data-take="10"] [data-name-format="enum"]>
 */
export function drawCharts(root, data) {
  root.querySelectorAll('[data-kind]').forEach((el) => {
    const d = el.dataset;
    let rows = getPath(data, d.rows) || [];
    if (d.nameFormat) rows = rows.map((r) => ({ ...r, name: FORMATS[d.nameFormat](r.name) }));
    const shown = d.take ? rows.slice(0, d.take) : rows;
    const series = (d.series || '').split(',').filter(Boolean).map((p) => { const [key, name] = p.split(':'); return { key, name }; });
    const height = d.height && Number(d.height);
    if (d.kind === 'line') lineChart(el, shown, series, { height: height || undefined, area: 'area' in d });
    if (d.kind === 'bar') barChart(el, shown, series, { height: height || undefined });
    if (d.kind === 'hbar') hbarChart(el, shown, series);
    if (d.kind === 'donut') donut(el, shown, { center: d.center, colors: d.colors === 'priority' ? PRIORITY_COLORS : undefined });
    const table = root.querySelector(`[data-chart-table="${d.chart}"]`);
    if (table && d.columns) chartTable(table, d.columns.split(',').map((c) => { const [key, label, fmt] = c.split(':'); return { key, label, format: FORMATS[fmt] }; }), rows);
  });
}
