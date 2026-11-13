# MediCore API contract

How every JSON response is shaped, which status codes mean what, and what clients may rely on. The endpoint list is in
[api-routes.md](api-routes.md) (generated). The OpenAPI 3.1 document built from it is described in the last-but-one section.

## Success

```jsonc
{ "success": true,
  "data": …,          // the result; omitted when there is nothing to return
  "message": "…" }    // optional human-readable confirmation (create/delete/restore actions)
```

* `data` is an object, a list, or — for paginated lists — `{ "items": [...], "pagination": { "page", "limit", "totalItems", "totalPages", "hasNextPage", "hasPreviousPage" } }`
  (see [Pagination](#pagination)). A few small or safety-critical lists deliberately stay bare arrays.
* HTTP status: `200`, or `201` for a created resource. There is no `204`.
* **Authentication** responses (`POST /auth/login`, `/auth/register`, `GET /auth/me`, `POST /auth/change-password`) now put their payload in
  `data` (`{ token, user }`, `{ user }`, `{ token }`). The same fields are still repeated at the top level for older clients;
  **the top-level copies are deprecated** and will be removed in a future release.
* `POST /api/auth/logout` returns `{ "success": true }` (no `data`; sessions are stateless JWTs, the call only records the audit event).
* `GET /api/health` returns `{ success, data: { status, time } }` (top-level `status`/`time` deprecated the same way).

### Responses that are not JSON (unchanged)

| Endpoint | Success response |
|---|---|
| `GET /api/files/reports/:id` | the stored file (`Content-Type` of the upload, `Content-Disposition`, `X-Content-Type-Options: nosniff`) |
| `GET /api/files/prescriptions/:id/pdf` | `application/pdf` |
| `GET /api/admin/reports/:type?format=csv` | `text/csv; charset=utf-8`, `Content-Disposition: attachment` |

When one of these fails, the response is the normal JSON **error** body below, never a half-written file.

## Pagination

Every list that can grow without bound is paginated on the server (database `skip`/`take` plus one `COUNT` with the same `where`):

```jsonc
GET /api/admin/users?role=DOCTOR&page=2&limit=5
{ "success": true,
  "data": { "items": [ … up to 5 … ],
            "pagination": { "page": 2, "limit": 5, "totalItems": 14, "totalPages": 3, "hasNextPage": true, "hasPreviousPage": true,
                            "total": 14 } } }      // `total` repeats totalItems for older clients and is deprecated
```

* **Query:** `?page` (whole number ≥ 1, default 1, at most 1,000,000) and `?limit` (whole number 1–100, default 20). Anything else — `0`, negative, fractional, text,
  empty, a limit above 100 — is `400 VALIDATION_ERROR` with `details: [{ field: "page" | "limit", message }]`; nothing is clamped silently.
* **Past the end:** `200` with `items: []`, the real `totalItems`, `hasNextPage: false`, `hasPreviousPage: true`. **Nothing found:** `items: []`, `totalItems: 0`, `totalPages: 0`.
* **Order and filters:** unchanged. Filters, search and the role/privacy rules are part of the query and are applied **before** the page is cut, so `totalItems` counts only what
  the caller may see. The sort has `id` as a last tie-breaker, so a page boundary never repeats or skips a row.
* **Extra top-level fields** stay beside `items`/`pagination`: `unread` (notifications), `actions` (audit log), `byAction`/`mostActive` (activity), and — new — `average`, `total`
  and `distribution` on `/doctor/reviews`, which describe **all** the doctor's reviews, whatever the page.

| Paginated (18) | Default sort |
|---|---|
| `GET /admin/{users, doctors, patients, appointments, emergencies, complaints, audit-logs, activity}` | newest first (patients/doctors: newest first, as before) |
| `GET /doctor/{appointments, prescriptions, reviews}`, `GET /doctor/patients` (A–Z) | as before |
| `GET /patient/{appointments, prescriptions, reviews}`, `GET /patient/reports` (also `?deleted=true`) | newest first |
| `GET /notifications`, `GET /complaints` | newest first |

**Changed in this item** (were bare arrays, now `{ items, pagination }`): `/doctor/patients` (its `?treating=true` filter now runs in the database), `/patient/prescriptions`,
`/patient/reviews`, `/complaints`, `/patient/reports`, and `/doctor/reviews` (`reviews` became `items`). The twelve lists that were already paginated keep their routes; their default
page size is now 20 (it was 20–50), `totalPages` is 0 (not 1) for an empty list, and `totalItems`, `hasNextPage`, `hasPreviousPage` were added.

**Deliberately not paginated:**

| Endpoint | Why |
|---|---|
| `GET /doctor/emergencies`, `GET /patient/emergencies` | live safety boards: a page boundary must never hide an active alert (the doctor board is already capped at 100) |
| `GET /patient/medical-records`, `GET /patient/allergies` | the patient's own profile lists, shown whole and split by type in the browser |
| `GET /doctor/referrals`, `GET /doctor/messages` | grouped responses (received/sent, inbox/sent); messages are capped at 100 per group |
| `GET /admin/departments`, `/doctor/colleagues`, `/doctor/availability`, `/admin/notifications/broadcasts` (last 50), `/public/departments`, `/public/doctors` | small, bounded, fixed lists used for pickers and the public site |
| dashboards, `/admin/reports/{type}`, `/public/stats`, `/public/doctors/{id}/slots` | aggregates, not lists |

The website's drop-downs that need every item (patients and doctors in the dialogs) follow `hasNextPage` (`api.all`, pages of 100).

## Errors

```jsonc
{ "success": false,
  "message": "Safe text you may show to the user",
  "error": { "code": "VALIDATION_ERROR", "status": 400, "details": [ { "field": "email", "message": "Invalid email" } ] },
  "details": …,        // legacy copy of error.details
  "requestId": "6f1c…" } // also the X-Request-Id response header
```

**Branch on `error.code`, never on `message`** (the wording may change). `details` is present only when it adds something.

| `error.code` | HTTP | Meaning / `details` |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Input failed validation. `details` = `[{ field, message }]`; `message` names the first field. |
| `BAD_REQUEST` | 400 | The request is understood but not acceptable (business rule). |
| `MALFORMED_JSON` | 400 | The body is not valid JSON. |
| `UPLOAD_ERROR` | 400 | Upload rejected (too large, wrong type, missing file). |
| `REASON_REQUIRED` | 400 | An administrator must send `X-Access-Reason` (10–500 characters). `details`: `{ code, minLength, maxLength }`. |
| `EXPORT_RANGE_TOO_LARGE` / `EXPORT_RANGE_INVALID` | 400 | Patient-identifying export range over 366 days / start after end. |
| `DATABASE_REQUEST_FAILED` | 400 | The database refused the request (for example a constraint). No detail is given. |
| `UNAUTHENTICATED` | 401 | No token, an invalid/expired token, a deactivated account, or wrong credentials. Clients should sign the user out. |
| `FORBIDDEN` | 403 | Signed in but not allowed (wrong role, no care relationship, not alerted for an emergency…). |
| `NOT_FOUND` | 404 | Unknown route or resource. |
| `CONFLICT` | 409 | State conflict (duplicate email, slot taken, already accepted…). |
| `PAYLOAD_TOO_LARGE` | 413 | Body over the 1 MB JSON limit. |
| `RATE_LIMITED` | 429 | Too many requests from this address. Honour the `Retry-After` header. |
| `ACCOUNT_LOCKED` | 429 | Too many failed sign-ins for this account. `details`: `{ retryAfterSeconds }`; `Retry-After` header set. |
| `INTERNAL_ERROR` | 500 | Unexpected failure. The message is generic; quote `requestId` to find the cause in the server log. |

Business rules and status codes are unchanged from before this standardisation; only the shape was made uniform.

### What a response never contains

Stack traces, SQL or Prisma text, file paths, the request body, password hashes, or clinical data inside an error. Tokens appear only in the four
authentication responses above. Unexpected errors are logged on the server with the request id (`[error] <requestId> METHOD /path`).

## Other conventions

* **Authentication:** `Authorization: Bearer <JWT>`. Sockets authenticate with the same token (`auth: { token }`).
* **Administrators' clinical access:** header `X-Access-Reason: <URL-encoded text>`; see the README ("Access to patient medical information").
* **Request id:** send `X-Request-Id` (8–64 characters of `A–Z a–z 0–9 . _ -`) to choose your own; otherwise one is generated. It is echoed on every response.
* **Socket.IO events** are not enveloped: the payload is the object itself (for example `notification:new`, `emergency:alert`, `appointment:updated`).
  Event names and payloads are unchanged by this work.
* **Dates** are ISO-8601 strings in UTC; date-only filters use `YYYY-MM-DD`.

## Frontend handling

`frontend/src/js/core/api.js` unwraps `data` (or returns the whole body when there is none), and throws `ApiError { message, status, code, details, requestId }`.
It tolerates non-JSON error bodies such as a gateway's HTML page. Server errors (5xx) show `ref <first 8 characters of requestId>` in the toast.

## OpenAPI document and Swagger UI

The API is described by an **OpenAPI 3.1** document: [`docs/openapi.json`](openapi.json) (generated, 112 operations, 76 reusable schemas).

* **Swagger UI:** `/api/docs` (through the website's proxy, `http://localhost:8089/api/docs` in the test setup; `http://localhost:5000/api/docs` directly).
  **Document:** `/api/openapi.json` (served byte for byte from `docs/openapi.json`).
* **Availability:** on in development and test. In **production it is off** (a standard `404 NOT_FOUND`) unless `API_DOCS=true` is set, because the document lists
  every endpoint and role. It contains no secrets, tokens, real patient data or database details (a test scans for them). Only the three Swagger UI files are served,
  with no inline script, so it works under the strict Content-Security-Policy. "Try it out" sends real requests: use the test database.
* **How it is produced** (`npm --prefix backend run openapi`, then commit the result; `tests/openapi.test.js` fails if `docs/openapi.json` is stale):
  * paths, methods, allowed roles (`x-roles`), the login requirement (JWT bearer security) and the **request schemas** come from the running router and the zod
    validators of `src/validators/schemas.js`; they cannot drift from the code;
  * summaries, query parameters, example request bodies and the response schema of each operation are written in `backend/src/openapi/routes.js`; the reusable
    response schemas (Appointment, Doctor, Patient, MedicalRecord, Prescription, Emergency, Notification, MedicalReport, errors…) in `backend/src/openapi/schemas.js`.
    Adding a route without documenting it, or documenting a route that does not exist, fails the build and the test.
* **How it is kept honest:** the test sends the documented example of every operation to the live API and validates every real response (all 112 operations, success and
  error shapes, CSV/PDF/file downloads, the 400/401/403/404/409 error bodies) against the documented schema, and runs every example through the real validator.
* **Documented separately:** downloads (`GET /files/reports/{id}`, `GET /files/prescriptions/{id}/pdf`, `GET /admin/reports/{type}?format=csv`) with their file content
  types and `Content-Disposition`; multipart uploads (`POST /patient/reports`, `POST /doctor/patients/{id}/reports`); the `X-Access-Reason` and `X-Request-Id` headers; the
  error code enumeration; and — as the `x-socketio` extension, because OpenAPI cannot describe them — the Socket.IO events.
* **Known limits of the document:**
  * nested relations inside responses (for example `appointment.patient`, `emergency.notifications`, the dashboards' `departmentStats`) are described by their stable
    fields only and are otherwise open objects; the schemas list what the API sends today and do not forbid extra fields;
  * query parameters are documented from the services' code; only some list routes validate their query (`listQuery`), the others ignore unknown parameters;
  * `MedicalReport` responses include `storedName`, the opaque random file name in storage (never a path); a future change could drop it;
  * lists that stay unpaginated on purpose are listed under [Pagination](#pagination).
* **Install note:** Swagger UI comes from the `swagger-ui-dist` package, which depends on `@scarf/scarf`, a package that reports install analytics when it is
  installed. To switch that off run `SCARF_ANALYTICS=false npm ci` (or `npm ci --ignore-scripts`; nothing in this project needs install scripts of that package).

## Future improvements (documented, not implemented)

1. **External audit hash-head monitoring.** Schedule `node backend/scripts/verify-audit-chain.js --print-head` and store the `seq:hash` line somewhere the database
   administrator cannot edit (a separate server, a write-once bucket, or an email to the security officer). Re-run it with `--expect-head=<stored>` on a timer and alert on
   any non-zero exit. This is what makes removal of the newest audit rows, or a consistent rewrite of the whole chain, detectable.
2. **Restricting the remaining clinical DELETE permissions.** The API role (`medicore_app`) can still `DELETE` rows in clinical tables, relying on code (soft deletion plus a
   test that forbids hard deletes) rather than the database. Revoke `DELETE` (and `TRUNCATE`) on patients, appointments, prescriptions, medical records, reports, allergies,
   emergencies and referrals from `medicore_app` in `database/roles.sql`, keeping it only on tables that really need it (notifications, schedule and assignment rewrites),
   then extend `tests/audit-protection.test.js` to prove it.
3. **Audit retention and erasure policy.** Decide, with hospital management and legal counsel, how long audit records are kept, what is archived (for example monthly
   partitions exported to write-once storage, never row-deleted), and who may approve and perform a privacy-law erasure or correction request against the audit log,
   including how that exceptional change is itself recorded. Until then nothing is deleted or partitioned.
