import { initPortal } from '../../core/shell.js';
import { directory } from '../public/directory.js';

await initPortal({ roles: ['PATIENT'] });
directory();
