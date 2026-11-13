const jwt = require('jsonwebtoken');
const { jwtSecret, jwtExpiresIn } = require('../config/env');

const signToken = (user) => jwt.sign({ sub: user.id, role: user.role }, jwtSecret, { expiresIn: jwtExpiresIn, issuer: 'smart-hospital' });
const verifyToken = (token) => jwt.verify(token, jwtSecret, { issuer: 'smart-hospital' });

// JWT "iat" has one-second precision, so the change time is stored at whole seconds:
// a token issued right after the change (same second) stays valid, every earlier token is rejected.
const passwordChangeStamp = () => new Date(Math.floor(Date.now() / 1000) * 1000);
/** True when the token was issued before the user's last password change or reset */
const issuedBeforePasswordChange = (payload, user) => Boolean(user.passwordChangedAt && payload.iat * 1000 < user.passwordChangedAt.getTime());

module.exports = { signToken, verifyToken, passwordChangeStamp, issuedBeforePasswordChange };
