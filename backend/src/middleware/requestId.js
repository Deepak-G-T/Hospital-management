// Gives every request an id (req.id) and returns it in the X-Request-Id header and in every error body, so a problem reported by a
// user can be found in the server log. An id sent by a proxy is reused only if it looks harmless.
const crypto = require('crypto');

const SAFE = /^[A-Za-z0-9._-]{8,64}$/;
module.exports = function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  req.id = typeof incoming === 'string' && SAFE.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};
