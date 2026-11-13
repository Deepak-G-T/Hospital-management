import { initPortal } from '../../core/shell.js';
import { doctorProfile } from '../public/profile.js';

await initPortal({ roles: ['PATIENT'] });
doctorProfile({ backHref: '/patient/find-doctors', backLabel: 'Back to doctors' });
