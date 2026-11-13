// Password hashing in one place (previously exported from auth.controller and imported by three admin controllers).
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 12;
// Compared against when an email has no account, so the response time doesn't reveal which emails exist
const DUMMY_HASH = bcrypt.hashSync('timing-safe-dummy-password', SALT_ROUNDS);

const hashPassword = (password) => bcrypt.hash(password, SALT_ROUNDS);

/** Checks a password against a stored hash; with no hash (unknown account) it still spends the same time and returns false */
const verifyPassword = (password, hash) => bcrypt.compare(password, hash || DUMMY_HASH).then((ok) => Boolean(hash) && ok);

module.exports = { hashPassword, verifyPassword, SALT_ROUNDS };
