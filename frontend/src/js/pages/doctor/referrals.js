// Referrals are declared in doctor/referrals.html; this only loads the referral dialog behaviour
import { initPortal } from '../../core/shell.js';
import './dialogs.js';

await initPortal({ roles: ['DOCTOR'] });
