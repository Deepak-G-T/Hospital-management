import { initPortal } from '../../core/shell.js';
import { source } from '../../core/auto.js';

const { user: me } = await initPortal({ roles: ['ADMIN'] });
source('#list', { map: (u) => ({ ...u, isMe: u.id === me.id }) }); // you can't deactivate yourself
