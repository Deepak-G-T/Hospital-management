import { api, download } from '../../core/api.js';
import { $, setState, options } from '../../core/dom.js';
import { withBusy, confirmDialog, toast } from '../../core/ui.js';
import { initPortal } from '../../core/shell.js';
import { dateRange } from '../../core/range.js';
import { chartTable } from '../../core/charts.js';
import { formatDate } from '../../core/format.js';

await initPortal({ roles: ['ADMIN'] });
const result = $('#result');
const dept = $('#dept');
const range = dateRange($('[data-range]'), 30, () => {});
const TITLES = { appointments: 'Appointments register', doctors: 'Doctor performance', departments: 'Department summary', patients: 'Patient registrations', emergencies: 'Emergency response', complaints: 'Complaints log' };
const type = () => $('#types input:checked').value;
// Reports that name patients need a recorded reason (and a range of at most 366 days; the server explains if it is exceeded)
const IDENTIFYING = ['patients', 'appointments', 'emergencies', 'complaints'];
async function askReason() {
  if (!IDENTIFYING.includes(type())) return { reason: undefined };
  const ok = await confirmDialog({
    title: 'Why do you need this report?', confirmLabel: 'Continue',
    message: 'This report lists patients. Your reason, the report type, the period and the number of rows are recorded in the audit log.',
    reason: 'Reason (required, at least 10 characters)',
  });
  if (!ok) return null;
  if ((ok.reason || '').length < 10) { toast('Please give a reason of at least 10 characters', 'error'); return null; }
  return { reason: ok.reason };
}
const params = () => ({ ...range.value, departmentId: ['appointments', 'doctors', 'departments', 'emergencies'].includes(type()) ? dept.value : '' });

$('#types').addEventListener('change', () => {
  $('[data-dept-field]').hidden = !['appointments', 'doctors', 'departments', 'emergencies'].includes(type());
  $('[data-empty-title]', result).textContent = 'Choose a report and click Generate';
  setState(result, 'empty');
});
$('#generate').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const access = await askReason();
  if (!access) return;
  setState(result, 'loading');
  const r = await withBusy(btn, () => api.get(`/admin/reports/${type()}`, params(), access));
  if (!r) { setState(result, 'error', 'Could not generate the report'); return; }
  $('[data-report-title]', result).textContent = TITLES[r.type];
  $('[data-report-meta]', result).textContent = `${formatDate(r.from)} – ${formatDate(r.to)} · ${r.total} rows`;
  if (!r.rows.length) { $('[data-empty-title]', result).textContent = 'No records in this period'; setState(result, 'empty'); return; }
  const columns = r.columns.map((label, i) => ({ key: i, label }));
  chartTable($('[data-report-table]', result), columns, r.rows.map((row) => Object.fromEntries(row.map((v, i) => [i, String(v)]))));
  setState(result, 'ready');
});
$('#export').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const access = await askReason();
  if (access) await withBusy(btn, () => download(`/admin/reports/${type()}`, { ...params(), format: 'csv' }, undefined, access), 'Report downloaded');
});
api.get('/admin/departments').then((d) => options(dept, d)).catch(() => {});
