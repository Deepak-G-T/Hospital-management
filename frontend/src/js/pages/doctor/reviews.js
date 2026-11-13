import { initPortal } from '../../core/shell.js';
import { source } from '../../core/auto.js';

await initPortal({ roles: ['DOCTOR'] });
// bars are relative to the most common rating
source('#reviews', { isEmpty: () => false, map: (d) => ({ ...d, distribution: d.distribution.map((x) => ({ ...x, pct: (x.count / Math.max(1, ...d.distribution.map((y) => y.count))) * 100 })) }) });
