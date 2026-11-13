# MediCore — Smart Hospital Management System

A full-stack hospital management and doctor-appointment platform with **three connected portals** (Admin, Doctor, Patient) that share one PostgreSQL database, real-time notifications over Socket.IO, and analytics built from live records.

| Layer | Technology |
|---|---|
| Frontend | Plain HTML pages + CSS (light/dark, no framework), small vanilla JavaScript modules, Vite (multi-page build, clean URLs, HTML partials), Socket.IO client, Lucide SVG icon sprite |
| Backend | Node.js, Express 4 (REST), zod validation, Helmet, rate limiting |
| Database | PostgreSQL 14+ via Prisma ORM 5 (migrations + seed) |
| Auth | JWT (Bearer) + bcrypt (12 rounds), role-based access control |
| Real-time | Socket.IO (JWT-authenticated sockets, per-user / per-role / per-doctor rooms) |
| Files | Multer (type + magic-byte validation, random stored names, authorised download only), PDFKit for prescriptions |

> The first version of the website used React, Tailwind, React Router, Axios and Recharts. It was rewritten as plain HTML and CSS pages with a small amount of vanilla JavaScript so the frontend is mostly HTML/CSS. The URLs, features, API, database and authentication did not change.

> ⚠️ The emergency module coordinates **in-hospital** response. It is **not** a replacement for emergency medical services — this is stated throughout the UI.

---

## 1. Quick start

### Prerequisites
- Node.js 18+ (tested on 22)
- PostgreSQL 14+ running locally (tested on 16)

### Steps

```bash
# 1. Create the empty database (adjust user/password to your setup)
createdb smart_hospital
```

```bash
# 2. Install dependencies for both apps
cd smart-hospital
npm run install:all
```

```bash
# 3. Create the database roles, tables and demo data in one step. Use your PostgreSQL ADMIN login here (it is used only by this
#    script). The audit log is append-only, so the API runs as a limited role and seeding uses a separate seeder role.
./database/setup-dev.sh "postgresql://postgres:postgres@localhost:5432/smart_hospital?schema=public"
# → writes backend/.env.roles (git-ignored) with the three role URLs
```

```bash
# 4. Configure the backend
cp backend/.env.example backend/.env
# edit backend/.env → DATABASE_URL = the DATABASE_URL line from backend/.env.roles (the app role, NOT the admin login), and JWT_SECRET
```

```bash
# 5. Start the API (http://localhost:5000)
npm run dev:backend
```

```bash
# 6. In a second terminal, start the website (http://localhost:5173)
npm run dev:frontend
```

Open **http://localhost:5173**. The Vite dev server proxies `/api` and `/socket.io` to the backend, so no CORS setup is needed locally.

### Demo accounts (created by the seed)

| Portal | Email | Password |
|---|---|---|
| Admin | `admin@medicore.com` | `Admin@123` |
| Doctor | `david.chen@medicore.com` (Cardiology — has a live emergency alert) | `Doctor@123` |
| Doctor | any seeded doctor, e.g. `sarah.mitchell@medicore.com`, `priya.raman@medicore.com` | `Doctor@123` |
| Patient | `patient@medicore.com` | `Patient@123` |

The login page also has one-click buttons that fill these in. **Change or remove them before any real deployment.**

The seed creates 10 departments, 14 doctors with weekly schedules, 32 patients, ~1,350 appointments over the past 75 days and next 14 days, prescriptions, reviews, allergies, medical history, emergency history, complaints and audit entries — so every chart has real database rows behind it. Re-running `npm --prefix backend run db:seed` wipes and recreates all data. As a safety guard, the seed **refuses to run** when `NODE_ENV=production`, or when the database already has user accounts but not the demo admin (it looks like real data). Nothing is deleted when it refuses.

### Running the tests

With the API running against a freshly seeded database:

```bash
npm test
```

`backend/tests/api.test.js` runs 23 end-to-end scenarios across all three portals: RBAC, validation, admin creating a doctor who then logs in, booking visible to doctor and admin, **double booking (sequential and concurrent race)**, status changes reaching the patient, rescheduling, emergency routing with a **real Socket.IO alert**, duplicate-accept protection, escalation, admin assignment, prescriptions as PDF, upload validation (spoofed files rejected), referrals, department messaging, complaints, reviews, analytics accuracy with filters, CSV reports, account deactivation, broadcasts and audit logs.

More backend suites (`npm test` runs all of them):
- `security.test.js`: seed guard, sessions ending on password change, socket disconnect and expiry, trusted audit IP, and login throttling.
- `architecture.test.js`: controllers never touch the database, and the patient-access rule is the same everywhere.
- `analytics.test.js`: the dashboard numbers are computed by PostgreSQL (grouped counts, plus day/month buckets in the server's `TZ`), and this suite proves they equal the previous in-memory calculation (`tests/reference/`) for many ranges, departments and doctors.
- `escalation.test.js`: automatic emergency escalation. It starts its **own** API instances with fast test-only targets (seconds instead of minutes), so stop any other API using the same test database first. Covers all four priorities, each level and who is alerted, that priority and assignment never change automatically, acknowledgement (pause, once per level, resume), acceptance/assignment/resolution/cancellation stopping escalation, three instances without duplicates, a crash before commit and recovery, production mode staying off, unauthorized acknowledgement, audited manual priority changes, and notifications stored before the Socket.IO push and fetched by clients that were offline.

- `access.test.js`: who may see patient medical information. Needs the API **and** its disposable `*_test` database (`API_URL=http://localhost:5001 DATABASE_URL=…_test npm run test:access`); it builds its own fixtures and checks every result through the real endpoints. Covers accepted, completed, rejected, cancelled, no-show and pending appointments, active and resolved emergencies, doctors who were only alerted, referrals, unrelated patients, report and prescription downloads, doctor writes, patient isolation, admin reasons, audit records (including refusing access when the audit entry cannot be written) and that no existing clinical data disappears.

- `privacy.test.js`: minimum necessary data. Appointment diagnosis/treatment/notes never reach administrators (API, dashboard, Socket.IO); the admin patient list has no blood group, height, weight or allergy counts; updates never overwrite stored data with blank values; patient-identifying exports need a reason, are limited to 366 days, carry no blood group and are audited as `REPORT_EXPORTED` (fail-closed, metadata only); the doctor's patient list shows blood group and allergy counts only for patients under treatment; notifications and socket payloads carry no symptoms; audit logs hold no clinical text. Same command pattern as `access.test.js` (`npm run test:privacy`).

- `pagination.test.js`: server-side pagination of the 18 paginated lists. The `{ items, pagination }` structure and defaults (page 1, limit 20, at most 100); invalid, negative, fractional and oversized `page`/`limit` are 400; first, middle, last, past-the-end and empty pages; filters and sorting across pages (same order whatever the page size, no row twice or missing); the doctor's rating summary counts all reviews on every page; soft-deleted reports; 401/403 on every list; patient privacy on every page (care relationship, blood group only under treatment, no clinical text for administrators, patients see only their own rows); no per-row queries (the database operation count does not grow with the page size); and the lists that intentionally stay unpaginated (`npm run test:pagination`, fresh seed).
- `openapi.test.js`: the OpenAPI 3.1 document and Swagger UI. The file is current and valid; all 112 routes are documented with the right roles and security; every example passes the real validators; the documented example of every operation is sent to the live API and each real response (success, errors, downloads) is validated against its schema; `/api/docs` and `/api/openapi.json` are served, only the three Swagger UI files are exposed, and the documentation is off in production unless `API_DOCS=true` (`npm run test:openapi`, fresh seed).
- `api-contract.test.js`: the response contract. Walks every route of the router as each role and anonymously (401/403 shapes, success envelope, no 500s), the authentication flows (bad, expired, forged tokens), malformed JSON, oversized bodies, rate limits, the 500 path (no stack, SQL, paths, secrets or request body in the response; the request id in the log), downloads staying raw, pagination, Socket.IO payloads, leak scans over every response, and that `docs/api-routes.md` is current. Run against a freshly seeded test database (`API_URL=… npm run test:contract`).
- `audit-protection.test.js`: the append-only audit log. Needs the three role URLs (`DATABASE_URL` = app role, `MIGRATOR_DATABASE_URL`, `SEED_DATABASE_URL`; optional `ADMIN_DATABASE_URL`) on a `*_test` database prepared with `database/roles.sql`. Checks the role privileges, that UPDATE/DELETE/TRUNCATE are refused (for the app role by privileges, for the owner by triggers), the seeder bypass, the hash chain under concurrency, detection of modified, deleted, inserted and reordered entries (simulated in rolled-back transactions), the verification script, and the seed and migration workflows.
- `softdelete.test.js`: soft deletion. Patients' deleted allergies, history entries and reports, and admins' deleted doctors and departments, are kept (row counts never drop, report files stay on disk), hidden from ordinary views, still visible and flagged to treating clinicians, restorable only by the right people (the owner; an admin with a recorded reason for clinical items; admins only for doctors and departments) and audited. `architecture.test.js` also fails if any service hard-deletes clinical, account or audit data.

The database-backed checks in the last three only run against a disposable database whose name ends in `_test`, e.g. `DATABASE_URL=…/smart_hospital_test TZ=America/New_York npm run test:analytics`.

**Browser tests** (need the API and website running, and a freshly seeded database; they use the pre-installed Playwright/Chromium):

```bash
npm run test:ui
```

```bash
npm run test:flow
```

- `frontend/tests/ui-sweep.cjs` visits every route of all three portals plus the public site (138 page views) at 1440px, 390px and 360px. It fails on console errors, error screens, **any horizontal overflow on phones**, icons squashed inside buttons, or a data table not in the expected layout (cards on phones, normal table on desktop). Options: `THEME=dark`, `MOTION=reduce`, `ONLY='<route regex>'`.
- `frontend/tests/flow.cjs` drives the real UI across portals: a patient books and the doctor sees it live and accepts, then the patient sees "Confirmed" live; the same for an emergency. Use `VIEWPORT=phone` to run it on an iPhone-sized screen.
- `frontend/tests/pagination-ui.cjs` drives the pager in a browser: Previous/Next and "Page x/y · n records" on first, middle and last pages, filters returning to page 1, the converted pages (doctor patients and reviews, prescriptions, complaints, reports), loading, empty and error states, a phone-sized screen, and the drop-downs that follow every page.
- `frontend/tests/api-docs-ui.cjs` loads Swagger UI in a real browser through the website's proxy: strict CSP without errors, no external requests, all 25 groups and 112 operations, the bearer-token dialog and padlocks, the documented request/error/CSV/PDF details and a live "Try it out".
- `frontend/tests/api-errors-ui.cjs` checks how the website shows API errors: real and injected login failures, a gateway's HTML error page, validation and rate-limit messages, a 500, and the expired-session redirect.
- `frontend/tests/actions.cjs` clicks through the create/edit/delete/submit actions of the admin, doctor and patient portals (99 checks; needs a freshly seeded test database). It does not depend on the time it runs: its emergency section puts the test doctor on shift all week through the doctor's own schedule endpoint (emergency alerts go to on-shift doctors first) and restores the schedule afterwards.
- `frontend/tests/softdelete-ui.cjs` drives deleting and restoring through the patient, doctor and admin portals ("Recently deleted", the "removed by patient" flag in the doctor's chart, the Deleted filters).
- `frontend/tests/privacy-ui.cjs` checks the admin patient list (no Blood column), registration with a blood group, edits that keep other fields, the report reason prompt, the 366-day error, the CSV download and the doctor's patient list.
- `frontend/tests/record-access-ui.cjs` checks the doctor's limited view of past patients and the admin reason prompt for patient and emergency details (needs a freshly seeded test database and API).
- `frontend/tests/escalation-ui.cjs` drives acknowledgement, a dropped and restored connection (catch-up of missed notifications), the admin escalation view and acceptance. It needs an API started with fast test-only targets and `ESCALATION_MAX_LEVEL=1` (see the comment at the top of the file); optional `DISCONNECT_CMD`/`RECONNECT_CMD` cut the connection for real (e.g. stop/start the reverse proxy).
- Reseed between runs (`npm --prefix backend run db:seed`), because the flow books slots and raises an emergency.

---

## 2. Project structure

```
smart-hospital/
├── package.json                 # convenience scripts for both apps
├── database/schema.sql          # full PostgreSQL DDL (exported from the Prisma migration)
├── backend/
│   ├── .env.example
│   ├── prisma/
│   │   ├── schema.prisma        # 21 models, enums, relations, indexes
│   │   ├── migrations/          # SQL migration incl. CHECK constraints + partial unique indexes
│   │   └── seed.js
│   ├── src/
│   │   ├── server.js            # HTTP + Socket.IO bootstrap
│   │   ├── app.js               # Express app, security middleware
│   │   ├── config/              # env loading, Prisma client
│   │   ├── routes/              # auth, public, admin, doctor, patient, shared
│   │   ├── controllers/         # thin HTTP handlers per portal: call a service, write the audit entry, send JSON (no database access)
│   │   ├── services/            # all database work and business rules, by domain (users, appointments, emergencies, prescriptions,
│   │   │                        #   records, reports, departments, complaints, notifications, analytics, portals, pdf…)
│   │   ├── policies/            # patientAccess.js — who may see a patient's clinical data (one definition)
│   │   ├── db/selects.js        # shared Prisma relation selections
│   │   ├── middleware/          # auth/RBAC, validation, uploads, rate limit, errors
│   │   ├── validators/          # zod schemas for every endpoint
│   │   ├── socket/              # Socket.IO server + emit helpers
│   │   └── utils/
│   ├── uploads/reports/         # stored report files (never served statically)
│   └── tests/                   # api.test.js (end-to-end), security.test.js (P0), architecture.test.js (layering + access policy)
└── frontend/                     # plain HTML + CSS; JavaScript only loads data and handles actions
    ├── tests/                   # ui-sweep.cjs (every page, 3 widths) and flow.cjs (cross-portal UI flow)
    ├── .env.example
    ├── vite.config.js           # multi-page build, clean URLs (/admin/doctors → admin/doctors.html), <!-- @include --> partials
    ├── index.html, about.html, departments.html, doctors.html, contact.html, login.html, register.html, 404.html
    ├── doctors/profile.html     # public doctor profile (/doctors/:id)
    ├── admin/                   # 12 admin pages (index.html = dashboard)
    ├── doctor/                  # 11 doctor pages
    ├── patient/                 # 10 patient pages
    ├── portal/                  # pages shared by portals: settings, notifications, complaints
    ├── partials/                # shared HTML: head, sidebar/header, footer, icon sprite, dialogs, booking, slot picker
    └── src/
        ├── css/                 # tokens (colours, light/dark), base, layout, components, tables & charts, pages
        └── js/
            ├── core/            # auto (HTML attributes: data-source, data-api, …), dom (template binding), api (fetch), ui, shell, socket, charts, booking
            ├── portal.js, public.js  # shared entry for pages that need no script of their own (most pages)
            └── pages/           # small scripts only where a page needs custom logic (slot picker, prescription builder, schedule editor, …)
```

---

## 3. Database

21 tables, all with UUID primary keys, `created_at`/`updated_at` as `TIMESTAMPTZ`, foreign keys with explicit `ON DELETE` behaviour, and indexes on every lookup path.

The 18 required tables: `users`, `admins`, `doctors`, `patients`, `departments`, `doctor_departments`, `appointments`, `doctor_availability`, `patient_medical_records`, `allergies`, `emergency_requests`, `emergency_notifications`, `prescriptions`, `medical_reports`, `complaints`, `notifications`, `doctor_reviews`, `audit_logs`.

Three more support the remaining features: `prescription_items` (normalised medicines), `emergency_events` (response timeline), `referrals` and `department_messages` (doctor collaboration).

**Integrity rules enforced in PostgreSQL itself** (see the bottom of the migration):
- **No double booking:** partial unique indexes on `(doctor_id, start_at)` and `(patient_id, start_at)` `WHERE status IN ('PENDING','CONFIRMED')`. Cancelled slots become bookable again. Booking also runs in a `SERIALIZABLE` transaction with an overlap check; the index is the final guard against races.
- One active emergency per patient (partial unique index).
- CHECK constraints: lowercase emails, rating 1–5, `day_of_week` 0–6, `HH:MM` time format, `end > start`, non-negative fees, location only stored with consent, sane height/weight, distinct referral doctors.
- Unique: user email, doctor licence number, prescription number, one review per appointment, one department link per doctor/department.

Useful commands (from `backend/`): `npm run db:migrate` (create a new migration after editing the schema), `npm run db:deploy`, `npm run db:seed`, `npm run db:reset`, `npm run db:studio`. Create an administrator without touching other data: `npm run create-admin` (see [9.2](#92-step-by-step-ubuntu--nginx--pm2)). `db:seed` and `db:reset` **delete all data**, so use them only on development databases.

---

## 4. Feature map

### Admin portal (`/admin`)
- **Dashboard** with date presets/custom range and a department filter: total doctors and patients, appointments in range, today, pending, completed, cancelled, emergencies (active and total), average emergency response time. Charts cover appointment trends, status donut, department statistics, emergencies by priority, patient registration trend, satisfaction distribution and doctor performance. Every chart has a table view and refreshes live via sockets.
- Doctors: add, edit, delete (deactivates instead when the doctor has clinical history), activate/deactivate, **assign multiple departments** with a primary one, view schedule.
- Patients: register, edit, activate/deactivate, view the full record (each view is audit-logged).
- Departments: create, edit, delete or deactivate; head doctor; emergency-routing keywords; emergency-department flag.
- Appointments: filter and search, approve, reject, cancel, complete.
- **Emergency monitoring:** live list, change priority or department, assign a doctor directly, re-alert doctors, resolve, view per-doctor responses and the timeline.
- Complaints from patients, doctors and the website contact form; respond and set status (the user is notified).
- User accounts: activate/deactivate, reset password.
- Doctor and patient activity feed with most-active users and top actions.
- Reports (appointments, doctor performance, departments, registrations, emergency response, complaints) as tables with **CSV export**.
- System notifications: broadcast to everyone or a role, see read counts, recall a broadcast. Also a personal inbox.
- Audit logs with filters and expandable details.

### Doctor portal (`/doctor`)
- Dashboard: total consultations, today/this week/this month, completed, cancelled, emergency cases, rating, trend, status donut, busiest weekdays, emergencies by priority, rating distribution. Also today's schedule, quick accept/reject of requests and a live emergency banner.
- Appointments: accept, reject, complete, no-show, cancel; record diagnosis, treatment and notes (optionally added to the patient's history); write a prescription.
- Schedule: weekly consultation hours (several blocks per day, copy to weekdays), slot length, emergency-alert opt-in.
- Patients: list limited to patients with a care relationship; the profile shows **allergies, blood group, history**, appointments, prescriptions, reports and emergencies. Add a diagnosis/record, upload a consultation report, refer.
- Digital prescriptions with an allergy warning, multiple medicines, follow-up date and **PDF download**.
- **Emergency board:** real-time alerts; accept (atomic, so only one doctor wins), escalate (priority goes up one level and the alert widens), resolve, view the timeline.
- Referrals (send, accept, decline, complete), inter-department messaging, patient feedback, complaints, profile, notifications, settings.

### Patient portal (`/patient`)
- Register (with privacy consent) and manage the profile, including emergency contact.
- Search doctors and departments, view profiles and specialisations, **check live slot availability** and book.
- Cancel or reschedule (rescheduling returns the appointment to pending for the doctor), view history with diagnosis and notes, rate and review completed visits.
- **Medical profile:** blood group, drug/food/environmental allergies with severity, existing conditions, medical history. Doctor-added records are read-only for the patient.
- Upload, view, download and delete medical reports.
- **Emergency:** choose a priority, describe symptoms (used to route to a department automatically), optionally share location with explicit consent (browser geolocation), see live status with a step tracker and timeline, cancel, view history.
- Download prescriptions as PDF, submit complaints, notifications inbox, settings.

### Emergency workflow
1. The patient submits a request with priority and symptoms (location only with consent).
2. All admins get a notification and a live `emergency:new` socket event.
3. The department is identified from the patient's choice, else by matching symptoms against each department's keywords, else the emergency department.
4. Available doctors are alerted (in-app notification and socket `emergency:alert`): emergency-enabled doctors in that department, on-shift first; CRITICAL cases also include the emergency department and all emergency-enabled doctors.
5. A doctor accepts (atomic conditional update, so a second accept gets `409`) or escalates (priority +1, escalation level +1, more doctors alerted).
6. The admin monitors and can reassign, assign directly, change priority (audited as `EMERGENCY_PRIORITY_CHANGED` with from/to), re-alert or resolve.
7. The patient sees status changes live. Every step is written to `emergency_events`, and `notified_at`/`accepted_at`/`resolved_at` give response-time tracking.

### Access to patient medical information

One policy (`backend/src/policies/patientAccess.js`) decides who sees a patient's clinical data, for the chart, history, allergies, prescriptions, reports, prescription PDFs and file downloads alike.

| Who | What they can see |
|---|---|
| **Patient** | Only their own data. |
| **Doctor, treatment** | A *confirmed* appointment (until `RECORD_ACCESS_GRACE_HOURS` after it ends, default 48, which also covers documenting a visit marked completed early) or an accepted referral: allergies, medical history, prescriptions and reports, the doctor's own appointments, and the emergencies they handled. May add records, reports, prescriptions and referrals. |
| **Doctor, emergency** | An emergency the doctor accepted while it is active: allergies, medical history and prescriptions only (no reports, no appointment history). Ends when the emergency closes. Always audit-logged. |
| **Doctor, history** | After a consultation, a closed emergency they handled or a completed referral: only the records tied to those consultations (written by the doctor or linked to their appointment). Anything the doctor wrote or issued stays accessible to them. |
| **Doctor, no access** | Rejected, cancelled, no-show and pending appointments, pending/declined referrals, emergencies they were only alerted to (the alert shows the emergency's own details while it is active; a closed one disappears from their board), and every unrelated patient. Refused attempts are audit-logged. |
| **Admin** | Operational data (names, appointments, emergency monitoring) needs no reason. **Clinical details** (allergies, medical history, report and prescription downloads, an emergency's allergy list) need a **reason of 10–500 characters**, sent in the `X-Access-Reason` header (URL-encoded) and recorded in the audit log. Without it the API returns the operational view, or `400` with `details.code = REASON_REQUIRED` for downloads. Emergency clinical details are available only while the emergency is active; for a closed one use the patient record. |

**Minimum data for administrators.** All administrators share the single `ADMIN` role, so the rules below apply to every admin:
- *Registration and operational data* — name, email, phone, address, date of birth, gender, emergency contact, account status, appointment and emergency counts, appointment scheduling data and reason — is shown without a reason.
- *Clinical data* — blood group, height, weight, allergies, medical history, and an appointment's diagnosis, treatment and notes — is not in admin lists, dashboards or socket events. Allergies, history, blood group, height and weight open only through the reason-gated patient detail; appointment diagnosis, treatment and notes are not shown to administrators at all.
- Blood group can be entered when an admin registers a patient. It is stored but never returned by the patient list or the create/update responses, and it cannot be changed through the admin update (which changes only fields that were sent with a value and differ from what is stored; blank values never erase data).
- Reports that name patients (`patients`, `appointments`, `emergencies`, `complaints`) need an `X-Access-Reason` (10–500 characters) and a date range of at most 366 days; otherwise the API answers `400` with `details.code` `REASON_REQUIRED`, `EXPORT_RANGE_TOO_LARGE` or `EXPORT_RANGE_INVALID`. The patient report has no blood group column. Every delivered report (JSON or CSV) is audited as `REPORT_EXPORTED` — user, report type, row count, column names, date range, format and reason, never row content — and the report is only delivered if that entry was written.
- Emergency notifications are generic ("New emergency request requires attention (ref 1a2b3c4d)"). Symptoms, descriptions and escalation reasons are shown only in the authorised emergency views and on the emergency timeline, never in stored notifications, socket alerts or audit metadata. Notifications created before this change keep their old text.
- *Future improvement:* administrator sub-roles (front desk, emergency coordinator, privacy officer, auditor) with different field access. This needs a schema change and a permissions design, so it is not part of the current release.

Exceptional access (admin with a reason, doctor access resting on an emergency) is written to the audit log as `MEDICAL_ACCESS_EXCEPTIONAL` (basis, reason, patient, what was opened, user, role, IP) **before** the data is released; if the entry cannot be written, access is refused. A doctor's emergency-board views of active emergencies are logged once per emergency per 15 minutes. `MEDICAL_ACCESS_DENIED` records refused doctor attempts. Existing clinical data is never deleted or changed by these rules; a doctor regains access when a new qualifying relationship exists. Accepting an emergency requires having been alerted for it.

### Audit log: append-only and tamper-evident

The audit log records who did what. It can only grow: rows are never changed or removed, and any tampering is detectable.

**Three layers of protection**
1. **Separate database roles** (`database/roles.sql`, idempotent; roles are cluster-wide, grants are per database):

   | Role | Used for | Rights |
   |---|---|---|
   | `medicore_migrator` | owns the tables; runs `prisma migrate deploy` (`DATABASE_URL=<migrator url> npm run db:deploy`) | schema changes; never used at runtime |
   | `medicore_app` | **the API at runtime** (`backend/.env` `DATABASE_URL`) | normal read/write on application tables; **SELECT and INSERT only on `audit_logs`**; owns nothing, no superuser, member of no role, cannot create objects or triggers, cannot `SET ROLE` to the others |
   | `medicore_seeder` | `npm run db:seed` only (`SEED_DATABASE_URL`); **development/test only, never created in production** | may TRUNCATE the audit log to reseed a demo database, and only while the database is marked non-production |

   The PostgreSQL superuser is for administration and backups only and must never be the application's `DATABASE_URL`.
2. **Database triggers**: `UPDATE` and `DELETE` on `audit_logs` are refused for everyone, including the owner; `TRUNCATE` is refused except for the seeder role on a database marked `development`/`test` (table `medicore_environment`, set by `roles.sql`, defaults to `production`). The user foreign key is `ON DELETE RESTRICT`, so deleting a user can no longer rewrite audit rows (users are soft-deleted).
3. **Hash chain**: every row stores `seq` (1, 2, 3… no gaps), `prev_hash` and `row_hash` = SHA-256 of the row's content plus the previous hash. A trigger computes it under an advisory lock, so concurrent inserts are serialised safely. `node scripts/verify-audit-chain.js` (read-only) detects modified, deleted, inserted and reordered entries. Rows that existed when the chain was introduced were numbered in `(created_at, id)` order and recorded in `audit_chain_baseline`; their earlier integrity cannot be proven, only what happened since. To also detect removal of the newest rows or a consistent rewrite of the whole chain, store the output of `node scripts/verify-audit-chain.js --print-head` somewhere the database administrator cannot edit (for example an emailed report or a write-once store) and check it later with `--expect-head=seq:hash`. A PostgreSQL superuser can still drop the triggers; the verification script and a stored head are what reveal that.

**Deploying** (production): create the database; run `roles.sql` as the admin with `-v env=production -v with_seeder=off`; run `db:deploy` with the migrator URL; run `roles.sql` again (it tightens grants on new tables); set the API's `DATABASE_URL` to the app role. Re-run `roles.sql` after every deploy. Use `database/setup-dev.sh` for a local database. Passwords are passed on the command line / in `.env`; never commit them.

**Retention and archiving.** Audit records are never deleted or partitioned by the application. Retention periods and archiving (for example moving old months to write-once storage) require hospital and legal approval and are **not decided yet**; until then everything is kept.

**Erasure and correction requests.** Audit records are never silently deleted or edited. A request to remove or correct personal data in the audit log must go through a documented privacy/legal review (who may approve, what is kept for legal duty, and how the change is itself recorded). Any approved change is performed deliberately by a database administrator, outside the application, and recorded in a separate, equally protected register; the hash chain will then show the gap, which is the intended evidence that a reviewed change happened. Free-text fields (such as access reasons) should therefore never contain clinical details.

**Future work (not part of this release):** coded access-reason categories with an optional short explanation, restricting who can read audit reasons, and administrator sub-roles (front desk, emergency coordinator, privacy officer, auditor).

### Deleting and restoring (soft deletion)

Nothing that belongs to a patient's care is ever removed by a delete button. Deleting sets `deleted_at` / `deleted_by_user_id` and hides the row from ordinary views; the row, its relations and (for reports) the file on disk stay.

| What | Who deletes | After deletion | Who restores |
|---|---|---|---|
| Allergy, history entry, report (written or uploaded by the patient) | The patient (doctor-written entries cannot be deleted by the patient) | Hidden from the patient's lists and from admins. **Treating clinicians still see it, marked "removed by patient"**, so safety information is not lost. Emergency boards list active allergies only. The report file cannot be downloaded by the patient or admins, but treating doctors keep access. | The patient ("Recently deleted"), or an administrator with a recorded reason (`POST /api/admin/restore/{records|allergies|reports}/:id`, audited as `MEDICAL_ITEM_RESTORED`) |
| Doctor | An administrator | Account deactivated, hidden from admin lists (`status=deleted` shows them) and the public directory, future appointments cancelled. Appointments, prescriptions, reviews, referrals and emergency history are kept and still show the doctor's name. | An administrator (`POST /api/admin/doctors/:id/restore`); cancelled appointments stay cancelled |
| Department | An administrator | Deactivated and hidden (`?deleted=true` shows them); history kept | An administrator (`POST /api/admin/departments/:id/restore`) |

Still permanently removable (not records requiring retention): a user's own notifications and recalled broadcasts, and the replace-all rewrites of a doctor's weekly schedule and department assignments. Audit logs, appointments, prescriptions, emergencies, referrals and reviews are never deleted by the application. Migration `20261111090000_soft_deletion` adds two nullable columns to five tables and changes no existing row.

### Automatic escalation of unaccepted emergencies

> **Safety.** Automatic escalation only widens **who is notified**. It never changes priority, never assigns a doctor, never accepts or resolves a case and never edits clinical data. A notification is not a guarantee that anyone responds, and this system does not replace calling real emergency services. The time targets below are **provisional operational targets, not clinically validated response times**; the hospital must approve them. The worker is **off by default in production**.

If nobody accepts an open emergency within the target for its priority, more staff are alerted, one level at a time:

| Level | Who is alerted |
|---|---|
| 1 | Emergency-available doctors of the emergency's department |
| 2 | Emergency-available doctors of the emergency department(s) |
| 3 | All emergency-available doctors **and all administrators** (final automatic level; staff oversight continues) |

Provisional targets (minutes without acceptance before each step): **Critical 2 · High 5 · Medium 15 · Low 30**. Doctors who handed the case on with a manual escalation are not re-alerted automatically.

- **Acknowledge** (doctor who was alerted, or admin): "I have seen it, assessment is in progress". It is *not* acceptance or assignment. It records `acknowledged_by`/`acknowledged_at` and pauses the next automatic step for one target interval. It is allowed once per level, so it cannot postpone escalation indefinitely; if nobody accepts, escalation resumes. `POST /api/doctor/emergencies/:id/acknowledge`, `POST /api/admin/emergencies/:id/acknowledge`.
- **Stops** when a doctor accepts, an admin assigns a doctor, or the case is resolved or cancelled (cleared in the same update). A doctor's manual escalation or an admin's priority change restarts the clock with the target of the (human-set) priority.
- **How it runs:** the schedule is stored in PostgreSQL (`emergency_requests.next_escalation_at`, database clock). Every API instance polls; a due case is claimed with `SELECT … FOR UPDATE SKIP LOCKED` in a transaction that writes the notifications, the timeline event, the `emergency_escalations` record and the next step together. A unique `(emergency_id, level)` index means a retry or a second instance can never escalate the same level twice. A crash before commit rolls everything back and the case is picked up again. Socket.IO events are sent only after commit; clients that were offline load the stored notifications (the website reloads the bell and the open lists when its live connection comes back).
- Every escalation appears on the emergency timeline (`AUTO_ESCALATED`) and in the audit log (`EMERGENCY_AUTO_ESCALATED`). Admins see the settings in effect at `GET /api/admin/escalation-config` and as a banner on the Emergencies page.
- Emergencies that existed before this feature was installed are never escalated automatically. Emergencies created while the worker is off are not escalated later either.
- Multiple API instances: notifications are stored for everyone, but a live Socket.IO push only reaches users connected to the instance that sent it (there is no shared Socket.IO adapter). Users connected elsewhere see the alert when their page reloads its notifications or reconnects.

---

## 5. User interface

- **HTML and CSS first.** Every page is a real HTML file; the sidebar, header, dialogs and other shared pieces are HTML partials (`frontend/partials`) included at build time. Lists and tables are `<template>` elements filled in by a small binding helper (`data-text`, `data-if`, `data-each`, …) in `src/js/core/dom.js`, so markup stays in HTML. Loading, empty, error and ready states, tabs, mobile cards, stars and most charts are drawn by CSS. JavaScript only fetches data, fills templates and handles actions.
- **Pages are declared in HTML.** What a page loads and what its forms and buttons do is written as attributes, handled by one shared module (`src/js/core/auto.js`), so most pages have no script of their own:

  | Attribute | Example | What it does |
  |---|---|---|
  | `data-source` | `<div data-source="/admin/users" data-template="tpl-row" data-filters="#filters" data-limit="20">` | Loads the data, renders the template (or fills one record), shows loading/empty/error states, paginates, reloads when filters change. `data-live="appointment:updated"` reloads on real-time events; `data-where` filters and `data-sort` sorts rows. |
  | `data-api` | `<form data-api="POST /admin/departments" data-api-edit="PUT /admin/departments/{id}" data-done="Saved">` | Validates and submits the form, shows the message, closes its dialog and refreshes the page's lists. |
  | `data-call` | `<button data-call="DELETE /patient/reports/{id}" data-confirm="Delete report?" data-danger>` | Calls the API, with an optional confirmation (and reason) dialog. |
  | `data-open` | `<button data-open="dept-dialog">` | Opens a dialog filled from the clicked row; `data-fill` forms are pre-filled for editing. |
  | `data-options` | `<select data-options="/admin/departments" data-option-label="{name}">` | Fills a drop-down from the API. |
  | `data-kind` | `<div data-chart="trend" data-kind="line" data-rows="appointmentTrend" data-series="total:Total">` | Draws a chart and its accessible table from the loaded data. |
  | `data-download` | `<button data-download="/files/reports/{id}">` | Downloads a protected file. |

  Tabs with `data-name` behave like form fields, the date-range bar works as a filter, and `{path|format}` placeholders format values (`date`, `enum`, `currency`, `or:fallback`, `pick:yes,no`, …). Registration uses the browser's own validation, with error hints shown by CSS (`:user-invalid`).
- **One design system for all three portals.** The same CSS components (`src/css`) give Admin, Doctor and Patient the same cards, badges, tables, charts and dashboard hero.
- **Navigation.** On desktop the sidebar collapses to an icon strip (remembered per browser) and shows a user card with a live-connection dot. The header shows the current page title. On phones there's a sliding menu drawer plus a bottom tab bar with each portal's four most-used pages and a "More" button.
- **Dashboards.** Each portal opens with a welcome banner (live summary figures; the doctor sees their next patient, the patient their next appointment), animated stat cards, and charts (CSS bars and donuts, SVG line charts) with hover tooltips and a table view.
- **Phones.** Every data table turns into stacked label/value cards under 768px and stays a normal table on desktop (pure CSS, using each cell's `data-label`). Dialogs (native `<dialog>`) become bottom sheets, and the date filter folds its custom dates away. Browser tests check that no page scrolls sideways at 390px or 360px.
- **Light and dark mode.** Both themes are tuned separately (including native date pickers and scrollbars), and the choice is remembered.
- **Motion.** Pages fade up, lists and stat cards appear in a short stagger, numbers count up, and hovers lift cards gently. Everything shortens to near-zero when the operating system asks for reduced motion.
- **Loading states.** Pages show shimmering placeholders shaped like the page instead of a spinner.

## 6. Security

- **RBAC** on every route (`authenticate` + `authorize(role)`); the frontend adds protected routes per role. The token is re-validated against the database on every request, so deactivated users are locked out immediately.
- **Medical data privacy:** doctors can only open patients they have an appointment, emergency or referral with; patients only see their own data; report and prescription downloads go through authorised endpoints, never static file serving. Viewing records, downloading files and every clinical write are audit-logged.
- **Audit log is append-only and tamper-evident** — see [Audit log](#audit-log-append-only-and-tamper-evident).
- Passwords are hashed with bcrypt (12 rounds) and never returned. Login timing is constant for unknown emails. Password policy is enforced.
- **Sessions end when the password changes.** Changing or resetting a password records `password_changed_at`; every token issued before it is rejected by the API and by Socket.IO. The person changing their own password stays signed in on that browser (the response includes a renewed `token`); other devices are signed out. An admin reset signs the user out everywhere.
- **Live connections follow the account.** Deactivating or deleting an account, or resetting its password, closes that user's Socket.IO connections at once, and every connection is closed when its token expires.
- **Per-account login throttling:** after `LOGIN_MAX_FAILURES` (5) failed logins for one email within `LOGIN_LOCK_MINUTES` (15), that email is locked for 15 minutes (HTTP 429 with `Retry-After`), even with the right password. Unknown emails are treated the same, so accounts can't be discovered this way. A successful login or an admin password reset clears it. This adds to the per-IP limit; the state is kept in memory per API instance.
- **Audit IP addresses** come from `req.ip`, which honours `trust proxy` (the address Nginx saw), not from the raw `X-Forwarded-For` header that clients can forge. Keep the API reachable only through Nginx (section 9).
- **Security headers on the website** (Nginx): Content-Security-Policy without inline scripts, Referrer-Policy and Permissions-Policy — see section 9.2, step 8.
- Every body, query and parameter is validated with zod, with clear 400 messages.
- Uploads are restricted by allow-listed MIME type and extension, checked against **magic bytes**, limited to 10 MB, stored under random names and removed if the request fails.
- The error handler maps Prisma/PostgreSQL errors to clean 4xx responses and never leaks stack traces or SQL in production.
- Also: Helmet headers, CORS restricted to `CLIENT_URL`, rate limiting (stricter on auth), JSON body size limit, a CSV-injection guard in exports, and a JWT secret length check in production.

---

## 7. API overview

Every JSON response has one of two shapes — `{ success: true, data?, message? }` or `{ success: false, message, error: { code, status, details? }, requestId }` — with stable
`error.code` values (`VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL_ERROR`, …) and an `X-Request-Id` header that matches the
server log. Downloads (CSV, PDF, report files) and Socket.IO events are not enveloped. Full contract, error-code table, OpenAPI preparation notes and the list of future improvements
(external audit hash-head monitoring, restricting clinical DELETE permissions, audit retention and erasure policy): **[docs/api-contract.md](docs/api-contract.md)**;
generated route inventory: [docs/api-routes.md](docs/api-routes.md) (`npm --prefix backend run routes` after adding an endpoint).

**Interactive API documentation (OpenAPI 3.1 / Swagger UI):** `/api/docs` (document: `/api/openapi.json`, file: [docs/openapi.json](docs/openapi.json)). Available in development; in
production it is off unless `API_DOCS=true`. After adding or changing an endpoint run `npm --prefix backend run openapi` and document it in `backend/src/openapi/routes.js`
(the tests fail until you do). Details: [docs/api-contract.md](docs/api-contract.md#openapi-document-and-swagger-ui).


All endpoints are under `/api`. Responses look like `{ success, data }` or `{ success: false, message, details? }`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register` · `POST /auth/login` (429 when the account is temporarily locked) · `GET /auth/me` · `PUT /auth/change-password` (also returns a renewed `token`) · `POST /auth/logout` |
| Public | `GET /public/stats` · `GET /public/departments[/:id]` · `GET /public/doctors[/:id]` · `GET /public/doctors/:id/slots?date=` · `POST /public/contact` |
| Admin | `/admin/dashboard` · `/admin/doctors` (CRUD, `PUT /:id/departments`) · `/admin/patients` · `/admin/departments` · `/admin/appointments` (+ `PATCH /:id/status`) · `/admin/emergencies` (+ `PATCH /:id`, `POST /:id/resolve`) · `/admin/complaints` (+ `PATCH /:id/respond`) · `/admin/users` (+ status, reset-password) · `/admin/activity` · `/admin/audit-logs` · `/admin/notifications/broadcast[s]` · `/admin/reports/:type?format=csv` |
| Doctor | `/doctor/dashboard` · `/doctor/profile` · `/doctor/availability` · `/doctor/appointments` (+ status, consultation) · `/doctor/patients[/:id]` (+ records, reports upload) · `/doctor/prescriptions` · `/doctor/emergencies` (+ seen, accept, escalate, resolve) · `/doctor/colleagues` · `/doctor/referrals` · `/doctor/messages` · `/doctor/reviews` |
| Patient | `/patient/dashboard` · `/patient/profile` · `/patient/appointments` (+ cancel, reschedule) · `/patient/medical-records` · `/patient/allergies` · `/patient/reports` · `/patient/emergencies` (+ cancel) · `/patient/prescriptions` · `/patient/reviews` |
| Shared | `/notifications` (list, read, read-all, delete) · `/complaints` · `/files/reports/:id` · `/files/prescriptions/:id/pdf` |

Socket events (client connects with `auth: { token }`): `notification:new`, `appointment:updated`, `emergency:new` (admins), `emergency:alert` (alerted doctors), `emergency:updated`.

---

## 8. Configuration

`backend/.env`

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string for the **`medicore_app`** role (never the PostgreSQL superuser) |
| `SEED_DATABASE_URL` | Development/test only: the `medicore_seeder` URL used by `npm run db:seed` |
| `JWT_SECRET` | Long random string (≥32 chars required in production) |
| `JWT_EXPIRES_IN` | Token lifetime, e.g. `1d` |
| `PORT` | API port (default 5000) |
| `CLIENT_URL` | Allowed CORS origin(s), comma-separated |
| `UPLOAD_DIR`, `MAX_UPLOAD_MB` | Upload storage folder and size limit |
| `AUTH_RATE_LIMIT` | Optional override for login/register attempts per IP per 15 min |
| `LOGIN_MAX_FAILURES`, `LOGIN_LOCK_MINUTES` | Per-account login throttling (default: 5 failures → 15-minute lock) |
| `TZ` | Optional. Appointment slots are generated in the server's timezone, so set it to the hospital's timezone (e.g. `America/New_York`) |
| `RECORD_ACCESS_GRACE_HOURS` | How long after an appointment ends a doctor still has treatment access to the patient (default 48). Afterwards only the records tied to the consultation remain visible |
| `ESCALATION_ENABLED` | Automatic emergency escalation worker: `true`/`false`. Default **on** in development/test, **off** when `NODE_ENV=production` |
| `ESCALATION_APPROVAL_REF` | Required in production *in addition to* `ESCALATION_ENABLED=true`: the hospital's approval reference (e.g. `Clinical governance 2026-11-12, item 4`). Without it the worker stays off and logs why |
| `ESCALATION_TARGETS` | Minutes without acceptance before each step, per priority. Default `CRITICAL=2,HIGH=5,MEDIUM=15,LOW=30` (provisional, pending hospital approval) |
| `ESCALATION_MAX_LEVEL` | Highest automatic level, 1–3 (default 3) |
| `ESCALATION_POLL_SECONDS` | How often each API instance checks for due escalations (default 15) |

`frontend/.env`: `VITE_API_URL` stays empty for local development (Vite proxy). Set it to the API origin when the API is hosted elsewhere.

For a production setup see **[9. Deployment](#9-deployment)**.

## 9. Deployment

This section describes a single Linux server running PostgreSQL, the API under PM2, and Nginx serving the website and proxying the API. These steps were rehearsed on Ubuntu 24.04 with Nginx 1.24, PM2 5 and PostgreSQL 16. The rehearsal used a fresh clone of this repository, a dedicated database user and a production `.env`. The API tests (23/23), the browser sweep (138 page views) and the phone cross-portal flow then all passed **through Nginx**, as did the update procedure and a backup restore. Steps that need a real server or domain were *not* part of the rehearsal: installing Node from NodeSource, `pm2 startup`, certbot/HTTPS and the `ufw` firewall.

### 9.1 What production needs

| Requirement | Why |
|---|---|
| A **long-running Node.js 18+ process** (not serverless functions) | Real-time notifications use Socket.IO, which needs a persistent server. |
| **Exactly one API instance** | Socket.IO rooms and the login rate-limit counters live in the process's memory. Do not use PM2 cluster mode (`-i`) or several replicas. |
| **PostgreSQL 14+** | The only data store. |
| A **persistent disk** for `UPLOAD_DIR` | Patients' medical reports are stored as files. Hosts with temporary disks would lose them on every restart. |
| A **reverse proxy** allowing WebSocket upgrades and request bodies of at least **12 MB** | Reports can be up to 10 MB. Nginx's default limit is 1 MB, which rejects such uploads with a `413` error. |
| **HTTPS** | Logins send passwords and tokens, and records contain medical data. |

> ⚠️ **Never run `npm run db:seed` or `npm run db:reset` on a production database.** The seed **deletes every table's data** and creates demo accounts whose passwords are published in this README. Create the first administrator with `npm run create-admin` instead (step 5).

### 9.2 Step by step (Ubuntu + Nginx + PM2)

The examples use the domain `hospital.example.com`, install the app in `/opt/medicore`, and run commands as a user with `sudo` rights.

**1. Install Node.js 22, PostgreSQL, Nginx and PM2**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
```

```bash
sudo apt-get install -y nodejs postgresql nginx
```

```bash
sudo npm install -g pm2
```

**2. Create a database and a dedicated database user**

Pick a strong password (for example from `openssl rand -hex 16`) and use it in both places below.

```bash
sudo -u postgres createdb medicore
# the three roles (see "Audit log: append-only and tamper-evident"); production has NO seeder role
sudo -u postgres psql -d medicore -v ON_ERROR_STOP=1 -v env=production -v with_seeder=off \
  -v migrator_pw="$(openssl rand -hex 16)" -v app_pw="$(openssl rand -hex 16)" -f /opt/medicore/database/roles.sql
```
Note the two passwords (set them yourself instead of the inline `openssl` calls if you need them again). `DATABASE_URL` in `.env` uses **`medicore_app`**; migrations use **`medicore_migrator`**. Never use the `postgres` login in `.env`.

**3. Get the code and create the uploads folder**

```bash
sudo git clone https://github.com/Deepak-G-T/hospital-management.git /opt/medicore
```

```bash
sudo mkdir -p /var/lib/medicore/uploads && sudo chown -R $USER /opt/medicore /var/lib/medicore
```

**4. Configure the API**

Generate a signing secret for login tokens:

```bash
openssl rand -hex 48
```

Create `/opt/medicore/backend/.env` with your values (the server refuses to start in production if `JWT_SECRET` is shorter than 32 characters):

```bash
cat > /opt/medicore/backend/.env <<'EOF'
NODE_ENV=production
PORT=5000
DATABASE_URL="postgresql://medicore:replace-with-a-strong-password@localhost:5432/medicore?schema=public"
JWT_SECRET="paste-the-output-of-openssl-rand-hex-48"
JWT_EXPIRES_IN="1d"
CLIENT_URL="https://hospital.example.com"
UPLOAD_DIR="/var/lib/medicore/uploads"
MAX_UPLOAD_MB=10
TZ="America/New_York"
EOF
```

```bash
chmod 600 /opt/medicore/backend/.env
```

`TZ` should be the hospital's timezone, because appointment slots are generated in server time. `CLIENT_URL` must be the exact address users open (scheme included), or the browser will block API and live-notification requests.

**5. Install the API, create the tables, create the first admin**

Use a full `npm ci`, without `--omit=dev`: the Prisma CLI that applies migrations is a development dependency.

```bash
cd /opt/medicore/backend && npm ci && DATABASE_URL="<medicore_migrator url>" npm run db:deploy
# then, as the PostgreSQL admin, re-run roles.sql (same -v options as above) so the new tables get the right grants
```

Create your administrator. If `ADMIN_PASSWORD` isn't set, you're prompted for it and the input is hidden. The script refuses existing emails and weak passwords, and changes nothing else.

```bash
cd /opt/medicore/backend && ADMIN_EMAIL=you@hospital.example.com ADMIN_NAME="Your Name" npm run create-admin
```

Once logged in as admin, you add doctors, departments and (optionally) patients from the admin portal. Patients can also register themselves.

**6. Build the website**

Leave `VITE_API_URL` empty: Nginx serves the website and the API from the same domain.

```bash
cd /opt/medicore/frontend && npm ci && npm run build
```

**7. Start the API with PM2 and keep it running after reboots**

Start it from the `backend` folder (that's where it reads `.env`) as a single instance:

```bash
cd /opt/medicore/backend && pm2 start src/server.js --name medicore-api --time
```

```bash
pm2 save
```

```bash
pm2 startup
```

`pm2 startup` prints one `sudo …` command. Run it, so the API starts automatically when the server boots. Logs: `pm2 logs medicore-api`.

**8. Configure Nginx**

Save as `/etc/nginx/sites-available/medicore`:

```nginx
# MediCore — serves the built website and proxies the API + Socket.IO
server {
    listen 80;
    server_name hospital.example.com;

    root /opt/medicore/frontend/dist;
    index index.html;

    # Report uploads are up to MAX_UPLOAD_MB (10 MB); nginx's default limit is only 1 MB
    client_max_body_size 12m;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;

    # REST API
    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # Real-time notifications (WebSocket upgrade)
    location /socket.io/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }

    # Hashed build assets can be cached for a long time
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    # Pages with an id in the URL, and pages shared by the portals
    rewrite ^/doctors/[^/]+$                                  /doctors/profile.html last;
    rewrite ^/patient/doctors/[^/]+$                          /patient/doctor.html  last;
    rewrite ^/doctor/patients/[^/]+$                          /doctor/patient.html  last;
    rewrite ^/(doctor|patient)/(notifications|complaints)$    /portal/$2.html       last;
    rewrite ^/(admin|doctor|patient)/settings$                /portal/settings.html last;

    # Multi-page site with clean URLs: /admin/doctors → admin/doctors.html, /admin → admin/index.html
    location / {
        try_files $uri $uri.html $uri/index.html =404;
        add_header Cache-Control "no-cache";

        # Security headers for every page (incl. the 404 page, hence "always").
        # They live here because an add_header inside a location cancels the ones inherited from server {}.
        # CSP: scripts only from this site (no inline scripts), Google Fonts, API + Socket.IO on the same origin.
        add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        # Geolocation stays allowed for this site (optional location sharing in patient emergencies)
        add_header Permissions-Policy "geolocation=(self), camera=(), microphone=(), payment=(), usb=()" always;
        add_header X-Content-Type-Options "nosniff" always;
    }
    error_page 404 /404.html;
}
```

About the security headers:
- **Content-Security-Policy** blocks scripts that don't come from your site, which protects the login token stored in the browser if an injection bug ever slips in. The website has no inline scripts or inline event handlers, so nothing needs `'unsafe-inline'` for scripts. Inline *styles* are allowed (`style-src 'unsafe-inline'`), because the pages use `style="…"` attributes for layout; that is far lower risk than inline scripts.
- If you host the API on a different domain (`VITE_API_URL`, section 9.5), add it to `connect-src`, for example `connect-src 'self' https://api.hospital.example.com wss://api.hospital.example.com`.
- The API sets its own security headers (Helmet), so `/api/` and `/socket.io/` don't need these.

Enable it, check the syntax, and reload:

```bash
sudo ln -sf /etc/nginx/sites-available/medicore /etc/nginx/sites-enabled/medicore && sudo rm -f /etc/nginx/sites-enabled/default
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

**9. Turn on HTTPS**

Point your domain's DNS at the server first, then:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
```

```bash
sudo certbot --nginx -d hospital.example.com
```

Certbot adds the certificate to the Nginx config and renews it automatically.

**10. Close the API port and check everything works**

Only ports 22, 80 and 443 should be reachable from outside. The API port (5000) should be reachable only through Nginx:

```bash
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

```bash
curl https://hospital.example.com/api/health
```

Then, in a browser:
- Open the site and log in with the admin you created.
- Reload a deep page such as `/admin/doctors`. It should load, not 404.
- Check that the green "live" dot appears on your avatar in the sidebar (Socket.IO is connected).
- Upload a medical report as a test patient.

### 9.3 Updating to a new version

```bash
cd /opt/medicore && git pull --ff-only
```

```bash
cd /opt/medicore/backend && npm ci && npm run db:deploy
```

```bash
cd /opt/medicore/frontend && npm ci && npm run build
```

```bash
pm2 reload medicore-api
```

`db:deploy` only applies new migrations and never deletes data. The website switches to the new build as soon as `npm run build` finishes.

> **Upgrading from a version without `password_changed_at`:** `db:deploy` adds one nullable column to `users` (`20261109120000_user_password_changed_at`). It changes no existing rows and signs nobody out. Also re-copy the Nginx `location /` block from step 8 to get the new security headers, then `sudo nginx -t && sudo systemctl reload nginx`.

### 9.4 Backups

Back up **both** the database and the uploaded reports. The database alone doesn't contain the report files.

```bash
sudo mkdir -p /var/backups/medicore
```

```bash
sudo -u postgres pg_dump -Fc medicore | sudo tee /var/backups/medicore/db-$(date +%F).dump > /dev/null
```

```bash
sudo tar -czf /var/backups/medicore/uploads-$(date +%F).tar.gz -C /var/lib/medicore uploads
```

To restore, first stop the API (`pm2 stop medicore-api`), then restore the database and the files, then start it again:

```bash
sudo -u postgres pg_restore --clean --if-exists -d medicore /var/backups/medicore/db-YYYY-MM-DD.dump
```

```bash
sudo tar -xzf /var/backups/medicore/uploads-YYYY-MM-DD.tar.gz -C /var/lib/medicore
```

Schedule the two backup commands daily (for example with `sudo crontab -e`) and copy the backup folder to another machine or to object storage. Backups on the same disk don't survive a disk failure.

### 9.5 Hosting the website and API separately (managed platforms)

You can also host the API and the website on different services. The specific providers weren't tested; these are the settings the app needs:

- **API (web service):**
  - Root folder `backend`, build command `npm ci && npm run db:deploy`, start command `npm start`.
  - Set the environment variables from step 4 (with `CLIENT_URL` = the website's address), use a managed PostgreSQL database, and attach a **persistent disk** mounted at `UPLOAD_DIR`.
  - Run **one instance** with WebSockets enabled.
- **Website (static site):**
  - Root folder `frontend`, build command `npm ci && npm run build`, publish folder `dist`.
  - Add rewrites (not redirects) for clean URLs. Most hosts serve `/about` from `about.html` automatically; the dynamic and shared pages need explicit rules, in this order:
    - `/doctors/:id` → `/doctors/profile.html`
    - `/patient/doctors/:id` → `/patient/doctor.html`
    - `/doctor/patients/:id` → `/doctor/patient.html`
    - `/doctor/notifications`, `/patient/notifications` → `/portal/notifications.html`
    - `/doctor/complaints`, `/patient/complaints` → `/portal/complaints.html`
    - `/admin/settings`, `/doctor/settings`, `/patient/settings` → `/portal/settings.html`
    - Unknown paths → `/404.html`
  - Set `VITE_API_URL` to the API's address (for example `https://api.hospital.example.com`) **before building**: it's baked into the build.
- **First admin:** run `npm run create-admin` once from the platform's shell/console in the `backend` folder.

### 9.6 Go-live checklist

- [ ] `JWT_SECRET` is a fresh random value (64+ characters), and `.env` is readable only by its owner (`chmod 600`).
- [ ] The demo seed was **never** run on this database; the admin came from `npm run create-admin`.
- [ ] **Demo login buttons removed:** delete the "Demo accounts" block (the `data-demo` buttons) in `frontend/login.html`, then rebuild. They only fill in seed credentials, which don't exist in production, but they shouldn't be shown to users.
- [ ] `CLIENT_URL` is the exact HTTPS address and `TZ` is the hospital's timezone.
- [ ] HTTPS works and the firewall blocks the API port.
- [ ] A test upload of a ~9 MB PDF works (proves the Nginx body size limit).
- [ ] Daily backups of the database **and** `/var/lib/medicore/uploads`, copied off the server, and a test restore done once.
- [ ] **Login rate limit:** production allows 20 login/registration attempts per IP per 15 minutes (`AUTH_RATE_LIMIT` changes it).
- [ ] **Automatic emergency escalation** stays off (the default) until the hospital has approved the targets, levels and recipients. To enable it: `ESCALATION_ENABLED=true` and `ESCALATION_APPROVAL_REF=<approval reference>`, then check the API log line `automatic emergency escalation is ON …` and the banner on the admin Emergencies page. It supplements, and never replaces, the hospital's emergency procedures.
- [ ] **Extra proxies:** the API trusts exactly one proxy (Nginx) for client IPs. If you put another proxy or CDN in front (e.g. Cloudflare), change `app.set('trust proxy', 1)` in `backend/src/app.js` to match.
