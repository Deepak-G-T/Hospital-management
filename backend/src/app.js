const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { clientUrl, isProd } = require('./config/env');
const { apiLimiter } = require('./middleware/rateLimit');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const requestId = require('./middleware/requestId');
const docs = require('./openapi/docs');
const { requestContext } = require('./utils/requestContext');
const routes = require('./routes');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(requestId); // first: every response, including errors from later middleware, carries X-Request-Id
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: clientUrl, credentials: true, exposedHeaders: ['X-Request-Id', 'Retry-After', 'Content-Disposition'] }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
if (!isProd) app.use(morgan('dev'));
app.use(requestContext); // lets the access policy audit with the full request details

// Uploaded files are NEVER served statically — they go through the authorised /api/files endpoints.
app.use('/api', apiLimiter, docs, routes); // docs: Swagger UI (/api/docs) and /api/openapi.json — off in production unless API_DOCS=true

app.use(notFound);
app.use(errorHandler);

module.exports = app;
