import { $$ } from '../../core/dom.js';
import { initPortal } from '../../core/shell.js';
import { source } from '../../core/auto.js';

await initPortal({ roles: ['ADMIN'] });
source('#list', {
  map: (d) => ({ ...d, departmentIds: d.departments.map((x) => x.departmentId), primaryDepartmentId: d.departments.find((x) => x.isPrimary)?.departmentId || '' }),
});
// the primary department must be one of the ticked ones (defaults to the first)
$$('#doctor-form, #depts-form').forEach((form) => {
  form.transform = (body) => {
    const ids = body.departmentIds || [];
    return { ...body, departmentIds: ids, primaryDepartmentId: ids.includes(body.primaryDepartmentId) ? body.primaryDepartmentId : ids[0] || null };
  };
});
