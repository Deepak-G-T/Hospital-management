// Socket.IO connection for live notifications/updates (JWT-authenticated like the REST API)
import { io } from 'socket.io-client';
import { API_ORIGIN, getToken } from './api.js';

let socket = null;
export function connect() {
  if (!socket) {
    // auth is read on every (re)connect, so a token renewed after a password change is used automatically
    socket = io(API_ORIGIN || '/', { auth: (cb) => cb({ token: getToken() }), transports: ['websocket', 'polling'] });
    // The server closes connections when a password changes, an account is deactivated or a token expires.
    // Try once more with the current token: it succeeds only if this browser still holds a valid session.
    socket.on('disconnect', (reason) => { if (reason === 'io server disconnect' && getToken()) setTimeout(() => socket.connect(), 1000); });
  }
  return socket;
}
/** Subscribe to one or more events */
export function onEvent(events, handler) {
  if (!socket) return;
  [].concat(events).forEach((e) => socket.on(e, handler));
}
