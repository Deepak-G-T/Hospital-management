import { initPortal } from '../../core/shell.js';
import { source } from '../../core/auto.js';

const { user } = await initPortal({ roles: ['DOCTOR'] });
// everything else is declared in doctor/index.html
source('#dash', {
  map: (d) => {
    const next = d.todaysAppointments.find((a) => new Date(a.endAt || a.startAt) >= new Date() && a.status !== 'COMPLETED');
    return { ...d, next, specialization: user.profile.specialization, todaysAppointments: d.todaysAppointments.map((a) => ({ ...a, isNext: a.id === next?.id })) };
  },
});
