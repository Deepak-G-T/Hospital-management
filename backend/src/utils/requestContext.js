// The HTTP request being handled, available anywhere below the route without passing `req` around.
// Used so the access policy can write complete audit entries (user, IP, user agent) by itself.
const { AsyncLocalStorage } = require('async_hooks');

const store = new AsyncLocalStorage();

/** Express middleware: runs the rest of the request inside the context */
const requestContext = (req, res, next) => store.run({ req }, next);

/** The current request, or undefined outside a request (scripts, tests that call services directly) */
const currentRequest = () => store.getStore()?.req;

module.exports = { requestContext, currentRequest };
