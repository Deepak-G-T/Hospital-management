import { api } from '../../core/api.js';
import { initPortal } from '../../core/shell.js';
import { source } from '../../core/auto.js';

const { user } = await initPortal({ roles: ['DOCTOR'] });
document.documentElement.classList.remove('has-emergency');
const me = user.profile.id;
const OPEN = ['PENDING', 'NOTIFIED', 'ESCALATED'];

source('#board', {
  map: (e) => {
    const mine = e.assignedDoctorId === me;
    return {
      ...e, mine,
      canEscalate: OPEN.includes(e.status) || (mine && e.status === 'ACCEPTED'),
      // "Seen — assessing": once per automatic-escalation level, only while nobody has accepted
      canAcknowledge: OPEN.includes(e.status) && !e.assignedDoctorId && e.acknowledgedLevel !== e.autoEscalationLevel && e.notifications.some((n) => n.doctorId === me),
      responseMin: e.acceptedAt ? Math.max(0, Math.round((new Date(e.acceptedAt) - new Date(e.createdAt)) / 60000)) : null,
    };
  },
  // mark new alerts as seen (response tracking)
  after: (list) => list.forEach((e) => { if (e.notifications.find((n) => n.doctorId === me)?.status === 'SENT') api.post(`/doctor/emergencies/${e.id}/seen`).catch(() => {}); }),
});
