const router = require('express').Router();
const h = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { auth } = require('../validators/schemas');
const c = require('../controllers/auth.controller');

router.post('/register', authLimiter, validate({ body: auth.register }), h(c.register));
router.post('/login', authLimiter, validate({ body: auth.login }), h(c.login));
router.get('/me', authenticate, h(c.me));
router.put('/change-password', authenticate, validate({ body: auth.changePassword }), h(c.changePassword));
router.post('/logout', authenticate, h(c.logout));

module.exports = router;
