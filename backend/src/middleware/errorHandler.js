// The one place that turns any error into an API response. Contract: docs/api-contract.md
//
//   { "success": false,
//     "message":  "Safe, human-readable text",
//     "error":    { "code": "VALIDATION_ERROR", "status": 400, "details": [ { "field": "email", "message": "…" } ] },
//     "details":  …same as error.details (legacy copy, kept for older clients),
//     "requestId": "…" }                       (also in the X-Request-Id header; find it in the server log)
//
// What never leaves the server: stack traces, SQL or Prisma text, file paths, the request body, tokens, passwords or any
// clinical data. For unexpected errors the client gets a generic message and the request id; the full error goes to the log.
const { Prisma } = require('@prisma/client');
const multer = require('multer');
const ApiError = require('../utils/ApiError');

function notFound(req, res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.path}`)); // path only: the query string is never echoed
}

/** Maps an error to { status, code, message, details } — only ApiErrors and known library errors carry their own text */
function describe(err) {
  if (err instanceof ApiError) return { status: err.statusCode, code: err.code, message: err.message, details: err.details };

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : String(err.meta?.target || '');
      let message;
      if (target.includes('email')) message = 'An account with this email already exists';
      else if (target.includes('start_at') || target.includes('slot')) message = 'This time slot has just been booked. Please choose another slot.';
      else if (target.includes('emergency')) message = 'You already have an active emergency request';
      else message = `A record with the same ${target || 'value'} already exists`;
      return { status: 409, code: 'CONFLICT', message };
    }
    if (err.code === 'P2025') return { status: 404, code: 'NOT_FOUND', message: 'Resource not found' };
    if (err.code === 'P2003') return { status: 409, code: 'CONFLICT', message: 'Related record not found or still in use' };
    if (err.code === 'P2034') return { status: 409, code: 'CONFLICT', message: 'The request conflicted with another update. Please retry.' };
    return { status: 400, code: 'DATABASE_REQUEST_FAILED', message: 'Database request failed' };
  }
  if (err instanceof Prisma.PrismaClientValidationError) return { status: 400, code: 'BAD_REQUEST', message: 'Invalid data supplied' };
  if (err instanceof multer.MulterError) return { status: 400, code: 'UPLOAD_ERROR', message: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message };
  if (err.type === 'entity.parse.failed') return { status: 400, code: 'MALFORMED_JSON', message: 'Malformed JSON body' };
  if (err.type === 'entity.too.large') return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large' };
  if (err.code === '23505' || /appointments_.*_active_key|emergency_requests_one_active/.test(err.message || '')) return { status: 409, code: 'CONFLICT', message: 'This time slot is no longer available' };
  if (err.code === '23514') return { status: 400, code: 'BAD_REQUEST', message: 'Data violates a validation rule' };
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again later.' };
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const { status, code, message, details } = describe(err);

  // Remove an uploaded file if the request ultimately failed
  if (req.file?.path) require('fs').unlink(req.file.path, () => {});

  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error(`[error] ${req.id || '-'} ${req.method} ${req.path}`, err); // full detail stays in the server log
  }

  res.status(status).json({
    success: false,
    message,
    error: { code, status, ...(details ? { details } : {}) },
    ...(details ? { details } : {}),
    requestId: req.id,
  });
}

module.exports = { notFound, errorHandler, describe };
