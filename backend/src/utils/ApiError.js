// An error the API deliberately reports to the client. Every ApiError carries a stable machine-readable `code`
// (see docs/api-contract.md); clients should branch on `code`, never on the message text.
const DEFAULT_CODES = { 400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 429: 'RATE_LIMITED' };

class ApiError extends Error {
  /** @param {number} statusCode  @param {string} message (safe to show to users)  @param {*} [details]  @param {string} [code] */
  constructor(statusCode, message, details, code) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    // An explicit code wins; otherwise a domain code carried in details (REASON_REQUIRED, EXPORT_RANGE_TOO_LARGE…); otherwise by status
    this.code = code || (details && !Array.isArray(details) && typeof details.code === 'string' ? details.code : undefined) || DEFAULT_CODES[statusCode] || (statusCode >= 500 ? 'INTERNAL_ERROR' : 'ERROR');
    this.isOperational = true;
  }
  static badRequest(msg = 'Bad request', details, code) { return new ApiError(400, msg, details, code); }
  /** 400 for invalid input; details = [{ field, message }] */
  static validation(msg = 'Validation failed', details) { return new ApiError(400, msg, details, 'VALIDATION_ERROR'); }
  static unauthorized(msg = 'Authentication required') { return new ApiError(401, msg); }
  static forbidden(msg = 'You do not have permission to perform this action') { return new ApiError(403, msg); }
  static notFound(msg = 'Resource not found') { return new ApiError(404, msg); }
  static conflict(msg = 'Conflict') { return new ApiError(409, msg); }
  static tooManyRequests(msg = 'Too many requests', details, code) { return new ApiError(429, msg, details, code); }
}
module.exports = ApiError;
