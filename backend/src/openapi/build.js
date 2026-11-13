// Builds the OpenAPI 3.1 document from (1) the real router (paths, methods, roles, login), (2) the zod request validators and
// (3) the hand-written documentation in ./routes.js and ./schemas.js. Output: docs/openapi.json (scripts/build-openapi.js --write).
const { z } = require('zod');
const pkg = require('../../package.json');
const { schemas: componentSchemas, ref } = require('./schemas');
const { routes: meta, Q } = require('./routes');

const TAGS = [
  ['System', 'Health check'], ['Authentication', 'Register, sign in, session and password'], ['Public', 'Hospital directory for the public website (no sign-in)'],
  ['Notifications', 'Your notifications (any signed-in user)'], ['Complaints', 'Complaints (doctor and patient)'], ['Files', 'Downloads of uploaded reports and prescription PDFs'],
  ['Admin · Dashboard & audit', 'Analytics, activity, audit log and reports'], ['Admin · Users', 'User accounts'], ['Admin · Doctors', 'Doctor accounts'], ['Admin · Patients', 'Patient accounts (no clinical data without a recorded reason)'],
  ['Admin · Departments', 'Departments'], ['Admin · Appointments', 'Appointments (no clinical text)'], ['Admin · Emergencies', 'Emergency requests'], ['Admin · Complaints', 'Complaint handling'], ['Admin · Notifications', 'Broadcasts'],
  ['Doctor · Portal', 'Dashboard, profile, availability, reviews'], ['Doctor · Appointments', 'Appointments and consultations'], ['Doctor · Patients', 'Patient charts, history, reports and prescriptions'],
  ['Doctor · Emergencies', 'Emergency alerts and responses'], ['Doctor · Collaboration', 'Referrals and department messages'],
  ['Patient · Portal', 'Dashboard, profile, reviews'], ['Patient · Appointments', 'Booking and managing appointments'], ['Patient · Health records', 'Medical history, allergies, reports (soft deletion)'],
  ['Patient · Prescriptions', 'Prescriptions'], ['Patient · Emergencies', 'Emergency requests'],
].map(([name, description]) => ({ name, description }));

function tagOf(m, p) {
  if (p === '/api/health') return 'System';
  if (p.startsWith('/api/auth')) return 'Authentication';
  if (p.startsWith('/api/public')) return 'Public';
  if (p.startsWith('/api/notifications')) return 'Notifications';
  if (p.startsWith('/api/complaints')) return 'Complaints';
  if (p.startsWith('/api/files')) return 'Files';
  if (p.startsWith('/api/admin')) {
    if (/dashboard|activity|audit|reports|escalation|restore/.test(p)) return 'Admin · Dashboard & audit';
    if (/users/.test(p)) return 'Admin · Users';
    if (/doctors/.test(p)) return 'Admin · Doctors';
    if (/patients/.test(p)) return 'Admin · Patients';
    if (/departments/.test(p)) return 'Admin · Departments';
    if (/appointments/.test(p)) return 'Admin · Appointments';
    if (/emergencies/.test(p)) return 'Admin · Emergencies';
    if (/complaints/.test(p)) return 'Admin · Complaints';
    return 'Admin · Notifications';
  }
  if (p.startsWith('/api/doctor')) {
    if (/appointments/.test(p)) return 'Doctor · Appointments';
    if (/patients|prescriptions/.test(p)) return 'Doctor · Patients';
    if (/emergencies/.test(p)) return 'Doctor · Emergencies';
    if (/referrals|messages|colleagues/.test(p)) return 'Doctor · Collaboration';
    return 'Doctor · Portal';
  }
  if (/appointments/.test(p)) return 'Patient · Appointments';
  if (/medical-records|allergies|reports/.test(p)) return 'Patient · Health records';
  if (/prescriptions/.test(p)) return 'Patient · Prescriptions';
  if (/emergencies/.test(p)) return 'Patient · Emergencies';
  return 'Patient · Portal';
}

/** zod schema -> JSON Schema (2020-12, as used by OpenAPI 3.1), describing what a client SENDS */
function fromZod(schema) {
  const j = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' });
  delete j.$schema;
  const clean = (n) => {
    if (Array.isArray(n)) return n.forEach(clean);
    if (n && typeof n === 'object') {
      if (['uuid', 'email'].includes(n.format)) delete n.pattern; // the format already says it; the generated regex is noise
      if (n.maximum === Number.MAX_SAFE_INTEGER) delete n.maximum;
      Object.values(n).forEach(clean);
    }
    return n;
  };
  return clean(j);
}

const okBody = (name) => {
  if (!name) return ref('Success');
  const list = name.endsWith('[]');
  const data = list ? { type: 'array', items: ref(name.slice(0, -2)) } : ref(name);
  return { allOf: [ref('Success'), { type: 'object', required: ['data'], properties: { data } }] };
};

const hdr = (n) => ({ $ref: `#/components/headers/${n}` });
const ERROR_ROWS = {
  400: ['ValidationError', 'The request is not acceptable: VALIDATION_ERROR (details = [{field, message}]), BAD_REQUEST, MALFORMED_JSON, UPLOAD_ERROR, REASON_REQUIRED, EXPORT_RANGE_TOO_LARGE or EXPORT_RANGE_INVALID'],
  401: ['Unauthenticated', 'UNAUTHENTICATED: no, invalid or expired token, a deactivated account, or wrong credentials. Clients should sign the user out.'],
  403: ['Forbidden', 'FORBIDDEN: signed in but not allowed (wrong role, no care relationship, not alerted for the emergency…)'],
  404: ['NotFound', 'NOT_FOUND: unknown route or resource'],
  409: ['Conflict', 'CONFLICT: state conflict (duplicate e-mail, slot taken, already accepted…)'],
  429: ['RateLimited', 'RATE_LIMITED (honour Retry-After) or, on sign-in, ACCOUNT_LOCKED (details.retryAfterSeconds)'],
  500: ['ServerError', 'INTERNAL_ERROR: unexpected failure. The message is generic; quote requestId to find the cause in the server log.'],
};

const errExample = (message, code, status, details) => ({ success: false, message, error: { code, status, ...(details ? { details } : {}) }, ...(details ? { details } : {}), requestId: '6f1c2b9e-3a4d-4e55-9c0a-7d2b1f8e4a10' });
const errResponse = (description, examples) => ({
  description, headers: { 'X-Request-Id': hdr('XRequestId') },
  content: { 'application/json': { schema: ref('ErrorResponse'), examples } },
});

const RESPONSE_EXAMPLES = {
  Health: { success: true, data: { status: 'ok', time: '2026-01-15T09:30:00.000Z' }, status: 'ok', time: '2026-01-15T09:30:00.000Z' },
  Session: { success: true, data: { token: '<jwt>', user: { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', email: 'patient@example.com', role: 'PATIENT', isActive: true, lastLoginAt: '2026-01-15T09:30:00.000Z', createdAt: '2025-10-09T09:34:00.000Z', profile: { id: '6eb547ff-e9d5-463a-bb0b-1a2b3c4d5e6f', userId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', fullName: 'Jane Doe', phone: '+1 555 0100' } } }, token: '<jwt>', user: { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', email: 'patient@example.com', role: 'PATIENT', isActive: true } },
  PublicStats: { success: true, data: { doctors: 14, patients: 32, departments: 10, completedAppointments: 454, avgRating: 4.2 } },
  BroadcastResult: { success: true, data: { broadcastId: '0b6e3b0e-1c2d-4a8e-9f10-5d6e7f8a9b0c', recipients: 47 } },
  NotificationPage: { success: true, data: { items: [{ id: '0b6e3b0e-1c2d-4a8e-9f10-5d6e7f8a9b0c', userId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', type: 'APPOINTMENT', title: 'Appointment confirmed', message: 'Your appointment on 15 Jan 2030 at 09:00 was confirmed.', link: '/patient/appointments', isRead: false, readAt: null, broadcastId: null, createdAt: '2030-01-10T08:00:00.000Z', updatedAt: '2030-01-10T08:00:00.000Z' }], pagination: { page: 1, limit: 20, totalItems: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false, total: 1 }, unread: 1 } },
  ReviewPage: { success: true, data: { items: [], pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false, total: 0 } } },
  Slots: { success: true, data: { doctorId: '7b1e0a3c-5d2f-4c1a-8e3b-000000000001', date: '2030-01-15', slotDurationMinutes: 30, slots: [{ time: '09:00', startAt: '2030-01-15T09:00:00.000Z', endAt: '2030-01-15T09:30:00.000Z', available: true, booked: false }] } },
  ReportResult: { success: true, data: { type: 'appointments', from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.999Z', columns: ['Date', 'Patient', 'Doctor', 'Status'], rows: [['2026-01-12 09:00', 'Jane Doe', 'Dr. Sam Rivera', 'COMPLETED']], total: 1 } },
};

const UPLOAD_DESC = 'Multipart upload. Field `file`: PDF, JPG, PNG, WEBP, TXT, DOC or DOCX (the content must match the declared type); one file, maximum size set by the server (MAX_UPLOAD_MB). The other fields are the report details.';

function operation(rt, key) {
  const [method, path] = [rt.method, rt.path];
  const [summary, dataName, opt = {}] = meta[key];
  const roles = rt.roles || null;
  const access = !rt.login ? 'Public (no sign-in).' : roles ? `Requires sign-in as: ${roles.join(', ')}.` : 'Requires sign-in (any role).';
  const lines = [access];
  if (opt.reason === 'unlocks') lines.push('Administrators receive the administrative data without a reason; the clinical sections (history, allergies, blood group, symptoms…) are included only when `X-Access-Reason` (10–500 characters, URL-encoded) is sent, and are otherwise withheld (`clinicalWithheld: true`). Every such access is audited. Doctors and patients are governed by the care-relationship policy instead.');
  else if (opt.reason) lines.push('Administrators must send `X-Access-Reason` (10–500 characters, URL-encoded); the access is audited. Without it the API answers `400 REASON_REQUIRED`.');
  if (/\/admin\/reports\//.test(path)) lines.push('Patient-identifying report types (`patients`, `appointments`, `emergencies`, `complaints`) need the reason, are limited to a 366-day range and are audited as `REPORT_EXPORTED`. `doctors` and `departments` are aggregate and need no reason.');
  if (/restore/.test(path)) lines.push('Restoring undoes a soft deletion; nothing was ever removed.');
  if (opt.multipart) lines.push(UPLOAD_DESC);
  if (path === '/api/auth/login') lines.push('After repeated failures the account is locked temporarily (`429 ACCOUNT_LOCKED`, `Retry-After`).');

  // parameters
  const parameters = [];
  const pj = rt.schemas?.params ? fromZod(rt.schemas.params) : { properties: {} };
  for (const name of [...path.matchAll(/:(\w+)/g)].map((m) => m[1])) {
    parameters.push({ name, in: 'path', required: true, description: name === 'id' ? 'Identifier (UUID)' : name === 'type' ? 'Report type' : name === 'kind' ? 'Kind of item' : name, schema: pj.properties?.[name] || { type: 'string' } });
  }
  const base = dataName && dataName.replace('[]', '');
  const paged = Boolean(base && componentSchemas[base]?.properties?.pagination);
  if (paged) lines.push('**Paginated:** `?page` (default 1) and `?limit` (default 20, maximum 100). A value that is not a whole number, a page below 1 or a limit outside 1–100 is a `400 VALIDATION_ERROR`; a page past the end returns empty `items` with `hasNextPage: false`. The filters and the access rules are applied before the page is cut.');
  const queryNames = paged ? [...new Set(['page', 'limit', ...(opt.q || [])])] : (opt.q || []);
  for (const q of queryNames) { const [description, schema] = Q[q]; parameters.push({ name: q, in: 'query', required: false, description, schema }); }
  if (opt.reason) parameters.push({ $ref: '#/components/parameters/AccessReason' });
  parameters.push({ $ref: '#/components/parameters/XRequestId' });

  const op = {
    tags: [tagOf(method, path)], summary, description: lines.join('\n\n'), operationId: null, parameters,
    security: rt.login ? [{ bearerAuth: [] }] : [],
    'x-roles': roles || (rt.login ? ['ADMIN', 'DOCTOR', 'PATIENT'] : []),
  };
  if (opt.reason) op['x-access-reason'] = opt.reason === 'unlocks' ? 'unlocks-clinical-detail' : 'required';

  if (rt.schemas?.body) {
    const schema = fromZod(rt.schemas.body);
    const example = opt.ex;
    if (opt.multipart) {
      op.requestBody = { required: true, description: UPLOAD_DESC, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file', ...(schema.required || [])], properties: { file: { type: 'string', format: 'binary', description: 'The report file' }, ...schema.properties } }, ...(example ? { example } : {}) } } };
    } else {
      op.requestBody = { required: (schema.required || []).length > 0, content: { 'application/json': { schema, ...(example ? { example } : {}) } } };
    }
  }

  // responses
  const responses = {};
  const status = String(opt.s || 200);
  const okHeaders = { 'X-Request-Id': hdr('XRequestId') };
  if (key === 'GET /api/files/reports/:id') {
    responses[status] = { description: 'The stored file. `Content-Type` is the type of the upload (pdf, jpeg, png, webp, plain text, doc, docx); `Content-Disposition` is `attachment` (or `inline` with `?inline=1`). This is NOT a JSON envelope; failures are the normal JSON error body.', headers: { ...okHeaders, 'Content-Disposition': hdr('ContentDisposition'), 'X-Content-Type-Options': { description: 'Always `nosniff`', schema: { const: 'nosniff' } } }, content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } }, 'image/jpeg': { schema: { type: 'string', format: 'binary' } }, 'image/png': { schema: { type: 'string', format: 'binary' } }, 'image/webp': { schema: { type: 'string', format: 'binary' } }, 'text/plain': { schema: { type: 'string', format: 'binary' } }, 'application/msword': { schema: { type: 'string', format: 'binary' } }, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { schema: { type: 'string', format: 'binary' } } } };
  } else if (key === 'GET /api/files/prescriptions/:id/pdf') {
    responses[status] = { description: 'The prescription as a PDF file (`Content-Disposition: attachment; filename="<prescription number>.pdf"`). NOT a JSON envelope; failures are the normal JSON error body.', headers: { ...okHeaders, 'Content-Disposition': hdr('ContentDisposition') }, content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } };
  } else if (key === 'GET /api/admin/reports/:type') {
    responses[status] = { description: 'JSON report (default), or — with `?format=csv` — a CSV file download (second content type; `Content-Disposition: attachment; filename="<type>-report-<date>.csv"`). CSV failures are the normal JSON error body.', headers: { ...okHeaders, 'Content-Disposition': { ...hdr('ContentDisposition'), description: 'Only for `format=csv`' } }, content: { 'application/json': { schema: okBody('ReportResult'), example: RESPONSE_EXAMPLES.ReportResult }, 'text/csv': { schema: { type: 'string' }, example: 'Date,Patient,Doctor,Status\n2026-01-12 09:00,Jane Doe,Dr. Sam Rivera,COMPLETED\n' } } };
  } else {
    const ex = RESPONSE_EXAMPLES[dataName];
    responses[status] = { description: opt.msg || !dataName ? (opt.msg ? 'Success, with a confirmation `message`' : 'Success (no data)') : 'Success', headers: okHeaders, content: { 'application/json': { schema: okBody(dataName), ...(ex ? { example: ex } : {}) } } };
  }
  if (rt.schemas || opt.multipart) responses['400'] = { $ref: '#/components/responses/ValidationError' };
  else if (opt.reason && opt.reason !== 'unlocks') responses['400'] = { $ref: '#/components/responses/ValidationError' };
  if (rt.login) responses['401'] = { $ref: '#/components/responses/Unauthenticated' };
  else if (path === '/api/auth/login') responses['401'] = { $ref: '#/components/responses/Unauthenticated' };
  if (roles || opt.reason) responses['403'] = { $ref: '#/components/responses/Forbidden' };
  if (/:\w+/.test(path)) responses['404'] = { $ref: '#/components/responses/NotFound' };
  if (opt.conflict) responses['409'] = { $ref: '#/components/responses/Conflict' };
  responses['429'] = { $ref: '#/components/responses/RateLimited' };
  responses['500'] = { $ref: '#/components/responses/ServerError' };
  op.responses = responses;
  return op;
}

const idFor = (method, path) => method.toLowerCase() + path.replace(/^\/api/, '').split('/').filter(Boolean).map((s) => (s.startsWith(':') ? `By${s[1].toUpperCase()}${s.slice(2)}` : s.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase()))).join('');

function build(routes) {
  const paths = {};
  for (const rt of routes) {
    const key = `${rt.method} ${rt.path}`;
    if (!meta[key]) throw new Error(`Route not documented in src/openapi/routes.js: ${key}`);
    const p = rt.path.replace(/^\/api/, '').replace(/:(\w+)/g, '{$1}') || '/';
    const op = operation(rt, key);
    op.operationId = idFor(rt.method, rt.path);
    (paths[p] ||= {})[rt.method.toLowerCase()] = op;
  }
  const known = new Set(routes.map((x) => `${x.method} ${x.path}`));
  for (const k of Object.keys(meta)) if (!known.has(k)) throw new Error(`Documented but not in the router: ${k}`);

  const sortedPaths = Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)));
  return {
    openapi: '3.1.0',
    info: {
      title: 'MediCore Smart Hospital API', version: pkg.version,
      description: [
        'REST API of the MediCore hospital system (admin, doctor and patient portals). Everything below is generated from the running router and its validators; response schemas are checked against live responses by the test-suite.',
        '', '**Authentication.** `POST /auth/login` returns a JWT. Send it as `Authorization: Bearer <token>`. Each operation lists the roles allowed to call it (`x-roles`); a wrong role is `403 FORBIDDEN`, a missing/invalid token `401 UNAUTHENTICATED`. Socket.IO uses the same token.',
        '', '**Responses.** Success: `{ "success": true, "data": …, "message"?: … }`. Error: `{ "success": false, "message", "error": { "code", "status", "details"? }, "requestId" }`. Branch on `error.code`, never on `message`. HTTP status codes are the ones listed per operation.',
        '', '**Request ids.** Every response carries `X-Request-Id` (also `requestId` in error bodies). Send your own (8–64 characters of `A–Z a–z 0–9 . _ -`) to correlate a call with the server log.',
        '', '**Deprecated duplicates.** The authentication responses and `/health` still repeat `token`, `user`, `status`, `time` at the top level for older clients, and errors repeat `details`. Use the `data` / `error` fields.',
        '', '**Downloads.** `GET /files/reports/{id}`, `GET /files/prescriptions/{id}/pdf` and `GET /admin/reports/{type}?format=csv` return files, not JSON; failures are still the JSON error body.',
        '', '**Clinical data and administrators.** Administrators see clinical detail only with `X-Access-Reason` (10–500 characters); every such access is audited. Deleting clinical items is a soft deletion (restorable).',
        '', '**Pagination.** Paged lists return `data: { items, pagination: { page, limit, total, totalPages } }`; other lists return a bare array in `data`.',
        '', '**Real-time events (Socket.IO, not REST).** Connect to the server root path `/socket.io` with `auth: { token }`. Events carry the payload object itself (no envelope): `notification:new`, `appointment:updated`, `emergency:new`, `emergency:updated`, `emergency:alert`. See `x-socketio`.',
        '', 'All example data in this document is fictitious.',
      ].join('\n'),
      license: { name: pkg.license || 'MIT' },
    },
    servers: [{ url: '/api', description: 'This server' }],
    tags: TAGS,
    paths: sortedPaths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT from `POST /auth/login` (or /auth/register). Sent as `Authorization: Bearer <token>`.' } },
      parameters: {
        AccessReason: { name: 'X-Access-Reason', in: 'header', required: false, description: 'Why an administrator needs this clinical information (URL-encoded text, 10–500 characters). Required for administrators on downloads, patient-identifying reports and clinical restores (`400 REASON_REQUIRED` without it); on patient and emergency detail it unlocks the clinical sections, which are otherwise withheld. Ignored for doctors and patients. Audited.', schema: { type: 'string', minLength: 10, maxLength: 500 } },
        XRequestId: { name: 'X-Request-Id', in: 'header', required: false, description: 'Optional correlation id (8–64 characters of A–Z a–z 0–9 . _ -). Echoed on the response; otherwise the server generates one.', schema: { type: 'string', minLength: 8, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' } },
      },
      headers: {
        XRequestId: { description: 'Identifies the request in the server log', schema: { type: 'string' } },
        RetryAfter: { description: 'Seconds to wait before retrying', schema: { type: 'integer' } },
        ContentDisposition: { description: 'Download file name', schema: { type: 'string' } },
      },
      responses: {
        ValidationError: errResponse(ERROR_ROWS[400][1], {
          validation: { summary: 'VALIDATION_ERROR', value: errExample('email: Invalid email address', 'VALIDATION_ERROR', 400, [{ field: 'email', message: 'Invalid email address' }]) },
          invalidPagination: { summary: 'Invalid ?page or ?limit', value: errExample('limit: limit must be at most 100', 'VALIDATION_ERROR', 400, [{ field: 'limit', message: 'limit must be at most 100' }]) },
          reasonRequired: { summary: 'REASON_REQUIRED (administrators)', value: errExample('A reason is required to view clinical information', 'REASON_REQUIRED', 400, { code: 'REASON_REQUIRED', minLength: 10, maxLength: 500 }) },
        }),
        Unauthenticated: errResponse(ERROR_ROWS[401][1], { unauthenticated: { value: errExample('Authentication required', 'UNAUTHENTICATED', 401) } }),
        Forbidden: errResponse(ERROR_ROWS[403][1], { forbidden: { value: errExample('You do not have permission to perform this action', 'FORBIDDEN', 403) } }),
        NotFound: errResponse(ERROR_ROWS[404][1], { notFound: { value: errExample('Resource not found', 'NOT_FOUND', 404) } }),
        Conflict: errResponse(ERROR_ROWS[409][1], { conflict: { value: errExample('An account with this email already exists', 'CONFLICT', 409) } }),
        RateLimited: { ...errResponse(ERROR_ROWS[429][1], { rateLimited: { value: errExample('Too many requests. Please slow down.', 'RATE_LIMITED', 429) }, accountLocked: { value: errExample('Too many failed sign-in attempts for this account. Try again in 15 minute(s).', 'ACCOUNT_LOCKED', 429, { retryAfterSeconds: 900 }) } }), headers: { 'X-Request-Id': hdr('XRequestId'), 'Retry-After': hdr('RetryAfter') } },
        ServerError: errResponse(ERROR_ROWS[500][1], { serverError: { value: errExample('Something went wrong. Please try again later.', 'INTERNAL_ERROR', 500) } }),
      },
      schemas: componentSchemas,
    },
    'x-socketio': {
      description: 'Socket.IO server on the same host (path /socket.io). Authenticate with auth: { token: <JWT> }; the connection closes when the token expires. Payloads are plain objects (not enveloped); clinical text is never included in alerts.',
      events: {
        'notification:new': { audience: 'the notified user', payload: '#/components/schemas/Notification' },
        'appointment:updated': { audience: 'the patient and doctor of the appointment; administrators receive an admin view without clinical text', payload: '#/components/schemas/Appointment' },
        'emergency:new': { audience: 'administrators', payload: 'emergency summary (no symptoms)' },
        'emergency:updated': { audience: 'administrators, alerted doctors and the patient', payload: 'emergency object' },
        'emergency:alert': { audience: 'alerted doctors', payload: '{ id, priority, … }  (no symptoms)' },
      },
    },
  };
}

module.exports = { build, fromZod };
