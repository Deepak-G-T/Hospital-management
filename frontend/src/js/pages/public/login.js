import { api, setToken, getToken } from '/src/js/core/api.js';
import { formValues, params } from '/src/js/core/dom.js';
import { busy, toast } from '/src/js/core/ui.js';
import { initPublic, ROLE_HOME, rememberRole } from '/src/js/core/shell.js';
initPublic();
const q = params();
const form = document.getElementById('login-form');
const error = document.getElementById('login-error');
document.getElementById('expired').hidden = !q.expired;
const go = (role) => {
  const next = q.next || '';
  location.replace(next && (next.startsWith(ROLE_HOME[role]) || next.startsWith('/doctors')) ? next : ROLE_HOME[role]);
};
// already signed in → straight to the portal
if (getToken() && !q.expired) api.raw('GET', '/auth/me').then(({ user }) => go(user.role)).catch(() => {});
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = form.querySelector('[type=submit]');
  const { email, password } = formValues(form);
  error.hidden = true;
  if (!email || !password) { error.textContent = 'Please enter your email and password'; error.hidden = false; return; }
  busy(btn, true);
  try {
    const res = await api.raw('POST', '/auth/login', { email: email.trim(), password });
    setToken(res.token); rememberRole(res.user.role);
    toast(`Welcome back, ${res.user.profile?.fullName?.split(' ')[0] || ''}!`, 'success');
    go(res.user.role);
  } catch (err) {
    error.textContent = err.message; error.hidden = false; busy(btn, false);
  }
});
