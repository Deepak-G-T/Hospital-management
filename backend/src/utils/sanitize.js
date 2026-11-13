// Strip sensitive fields before sending user objects to clients
function publicUser(user) {
  if (!user) return null;
  // eslint-disable-next-line no-unused-vars
  const { passwordHash, ...rest } = user;
  return rest;
}
module.exports = { publicUser };
