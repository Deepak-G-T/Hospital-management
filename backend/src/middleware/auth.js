const prisma = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { verifyToken, issuedBeforePasswordChange } = require('../utils/token');

/** The X-Access-Reason header, decoded; undefined when absent. Not validated here: policies/patientAccess.js does that. */
function readAccessReason(req) {
  const raw = req.headers['x-access-reason'];
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

// Verifies the JWT, re-checks that the account still exists and is active and that the token
// was not issued before the last password change, and attaches { id, email, role, profileId, fullName } to req.user.
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw ApiError.unauthorized();

    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      throw ApiError.unauthorized('Session expired or invalid. Please log in again.');
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { admin: true, doctor: true, patient: true },
    });
    if (!user || !user.isActive) throw ApiError.unauthorized('Account not found or deactivated');
    if (issuedBeforePasswordChange(payload, user)) throw ApiError.unauthorized('Your password was changed. Please log in again.');

    const profile = user.admin || user.doctor || user.patient;
    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      profileId: profile ? profile.id : null,
      fullName: profile ? profile.fullName : user.email,
      // Reason an administrator gives for opening clinical details (X-Access-Reason, URL-encoded). Validated by the policy.
      accessReason: readAccessReason(req),
    };
    next();
  } catch (err) {
    next(err);
  }
}

// Role-based access control
const authorize = (...roles) => {
  const middleware = (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) return next(ApiError.forbidden());
    if (!req.user.profileId) return next(ApiError.forbidden('Profile not set up for this account'));
    return next();
  };
  middleware.roles = roles; // read by scripts/list-api-routes.js (the API inventory); has no effect at runtime
  return middleware;
};
authenticate.requiresLogin = true;

module.exports = { authenticate, authorize };
