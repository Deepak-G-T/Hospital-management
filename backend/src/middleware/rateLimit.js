const rateLimit = require('express-rate-limit');
const ApiError = require('../utils/ApiError');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT) || (process.env.NODE_ENV === 'production' ? 20 : 300),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res, next) => next(ApiError.tooManyRequests('Too many attempts. Please try again in a few minutes.')),
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res, next) => next(ApiError.tooManyRequests('Too many requests. Please slow down.')),
});

module.exports = { authLimiter, apiLimiter };
