const ApiError = require('../utils/ApiError');
const { signToken } = require('../utils/token');
const { audit } = require('../services/audit.service');
const loginThrottle = require('../services/loginThrottle');
const users = require('../services/user.service');

exports.register = async (req, res) => {
  const user = await users.registerPatient(req.body);
  req.user = { id: user.id, role: user.role };
  audit(req, 'REGISTER', 'User', user.id, { role: 'PATIENT' });
  const session = { token: signToken(user), user: await users.loadSessionUser(user.id) };
  res.status(201).json({ success: true, data: session, ...session }); // top-level token/user: deprecated duplicates, kept for older clients
};

// Per-account lock (services/loginThrottle.js) on top of the per-IP limiter
function rejectIfLocked(req, res, email, seconds) {
  if (!seconds) return;
  res.set('Retry-After', String(seconds));
  audit(req, 'LOGIN_LOCKED', 'User', null, { email });
  throw ApiError.tooManyRequests(`Too many failed sign-in attempts for this account. Try again in ${Math.ceil(seconds / 60)} minute(s).`, { retryAfterSeconds: seconds }, 'ACCOUNT_LOCKED');
}

exports.login = async (req, res) => {
  const { email, password } = req.body;
  rejectIfLocked(req, res, email, loginThrottle.lockedFor(email));
  const { user, valid } = await users.checkCredentials(email, password);
  if (!valid) {
    audit(req, 'LOGIN_FAILED', 'User', user?.id, { email });
    rejectIfLocked(req, res, email, loginThrottle.recordFailure(email)); // this failure may have locked the account
    throw ApiError.unauthorized('Invalid email or password');
  }
  loginThrottle.clear(email);
  if (!user.isActive) throw ApiError.forbidden('Your account has been deactivated. Please contact the hospital administration.');
  await users.recordLogin(user.id);
  req.user = { id: user.id, role: user.role };
  audit(req, 'LOGIN', 'User', user.id);
  const session = { token: signToken(user), user: await users.loadSessionUser(user.id) };
  res.json({ success: true, data: session, ...session });
};

exports.me = async (req, res) => {
  const user = await users.loadSessionUser(req.user.id);
  res.json({ success: true, data: { user }, user });
};

exports.changePassword = async (req, res) => {
  // Every session issued before now (other devices, stolen tokens) stops working
  const updated = await users.changeOwnPassword(req.user.id, req.body.currentPassword, req.body.newPassword);
  audit(req, 'PASSWORD_CHANGED', 'User', updated.id);
  // `token` keeps the current session signed in after the change
  const token = signToken(updated);
  res.json({ success: true, message: 'Password updated successfully', data: { token }, token });
};

exports.logout = async (req, res) => {
  audit(req, 'LOGOUT', 'User', req.user.id);
  res.json({ success: true });
};
