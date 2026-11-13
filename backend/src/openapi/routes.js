// Human-written documentation of every route: summary, response data schema, documented query parameters and example request bodies.
// What the generator takes from the code instead: the path, method, allowed roles, login requirement and request validation (zod).
// tests/openapi.test.js fails when a route is missing here (or documented here but gone), when an example does not pass the real
// validator, and when a live response does not match the schema named here.

// Placeholder ids used in examples (valid UUIDs; the tests swap them for real ids of the test database)
const ID = {
  doctor: '7b1e0a3c-5d2f-4c1a-8e3b-000000000001', department: '7b1e0a3c-5d2f-4c1a-8e3b-000000000002', patient: '7b1e0a3c-5d2f-4c1a-8e3b-000000000003',
  appointment: '7b1e0a3c-5d2f-4c1a-8e3b-000000000004', doctor2: '7b1e0a3c-5d2f-4c1a-8e3b-000000000005',
};

const Q = {
  page: ['Page number, starting at 1 (default 1). A page past the end returns empty `items`.', { type: 'integer', minimum: 1, maximum: 1000000, default: 1 }], limit: ['Items per page (default 20, maximum 100)', { type: 'integer', minimum: 1, maximum: 100, default: 20 }],
  search: ['Free-text search', { type: 'string', maxLength: 100 }], status: ['Filter by status', { type: 'string', maxLength: 30 }], priority: ['Filter by priority', { type: 'string', maxLength: 30 }],
  role: ['Filter by role (ADMIN, DOCTOR, PATIENT)', { type: 'string', maxLength: 30 }], departmentId: ['Filter by department', { type: 'string', format: 'uuid' }], doctorId: ['Filter by doctor', { type: 'string', format: 'uuid' }],
  from: ['Start date, YYYY-MM-DD (default: 30 days before `to`)', { type: 'string', format: 'date' }], to: ['End date, YYYY-MM-DD (default: today)', { type: 'string', format: 'date' }],
  action: ['Filter by audit action name', { type: 'string', maxLength: 100 }], type: ['Filter by type', { type: 'string', maxLength: 40 }],
  scope: ['View scope (appointments: upcoming/past/…; emergencies: active/history/all)', { type: 'string', maxLength: 30 }], format: ['`json` (default) or `csv` (file download)', { type: 'string', enum: ['json', 'csv'] }],
  deleted: ['`true` lists the items you deleted (soft deletion) instead of the active ones', { type: 'boolean' }], treating: ['`true` limits the list to patients under the doctor\'s current treatment', { type: 'boolean' }],
  date: ['Day to list slots for, YYYY-MM-DD', { type: 'string', format: 'date' }], exclude: ['Appointment id to ignore when checking availability (while rescheduling)', { type: 'string', format: 'uuid' }],
  inline: ['`1` displays the file in the browser instead of downloading it', { type: 'string', enum: ['1'] }],
};

// key: [summary, responseDataSchema | null, options]   options: s = success status (default 200), q = query params, reason = X-Access-Reason applies,
//   ex = example request body, msg = success carries a confirmation message, conflict = can answer 409, multipart = file upload
const r = {
  // ── System and authentication ──
  'GET /api/health': ['Health check', 'Health'],
  'POST /api/auth/register': ['Register a patient account', 'Session', { s: 201, conflict: true, ex: { email: 'new.patient@example.com', password: 'Start@1234', fullName: 'Jane Doe', phone: '+1 555 0100', dateOfBirth: '1990-04-12', gender: 'FEMALE' } }],
  'POST /api/auth/login': ['Sign in', 'Session', { ex: { email: 'patient@example.com', password: 'Your-password-1' } }],
  'POST /api/auth/logout': ['Sign out (records the audit event; the JWT is stateless)', null],
  'GET /api/auth/me': ['The signed-in account', 'CurrentUser'],
  'PUT /api/auth/change-password': ['Change your password', 'TokenOnly', { msg: true, ex: { currentPassword: 'Old-password-1', newPassword: 'New-password-2' } }],

  // ── Public ──
  'GET /api/public/stats': ['Hospital statistics for the public website', 'PublicStats'],
  'GET /api/public/departments': ['List active departments', 'PublicDepartment[]', { q: ['search'] }],
  'GET /api/public/departments/:id': ['One department with its doctors', 'PublicDepartmentDetail'],
  'GET /api/public/doctors': ['List doctors (public directory)', 'PublicDoctor[]', { q: ['search', 'departmentId'] }],
  'GET /api/public/doctors/:id': ['One doctor with schedule and reviews', 'PublicDoctorDetail'],
  'GET /api/public/doctors/:id/slots': ['Bookable time slots of a doctor on a day', 'Slots', { q: ['date', 'exclude'] }],
  'POST /api/public/contact': ['Send a message to the hospital (contact form)', null, { s: 201, msg: true, ex: { name: 'Jane Doe', email: 'jane@example.com', subject: 'Visiting hours', message: 'What are the visiting hours of the cardiology ward?' } }],

  // ── Notifications and complaints (any signed-in user / doctor and patient) ──
  'GET /api/notifications': ['Your notifications', 'NotificationPage', { q: ['page', 'limit', 'status', 'type'] }],
  'PATCH /api/notifications/read-all': ['Mark all your notifications as read', 'UpdatedCount'],
  'PATCH /api/notifications/:id/read': ['Mark one notification as read', null],
  'DELETE /api/notifications/:id': ['Delete one of your notifications', null],
  'GET /api/complaints': ['Complaints you filed, paginated', 'ComplaintPage'],
  'POST /api/complaints': ['File a complaint', 'Complaint', { s: 201, ex: { subject: 'Long waiting time', description: 'I waited for over an hour past my appointment time.', category: 'SERVICE' } }],

  // ── Files ──
  'GET /api/files/reports/:id': ['Download an uploaded medical report', null, { reason: true, q: ['inline'] }],
  'GET /api/files/prescriptions/:id/pdf': ['Download a prescription as PDF', null, { reason: true }],

  // ── Admin: analytics, activity, audit, reports ──
  'GET /api/admin/dashboard': ['Hospital dashboard analytics', 'AdminDashboard', { q: ['from', 'to', 'departmentId'] }],
  'GET /api/admin/activity': ['User activity feed with per-action counts', 'ActivityFeed', { q: ['page', 'limit', 'role', 'action', 'from', 'to', 'type'] }],
  'GET /api/admin/audit-logs': ['Audit log (append-only, tamper-evident)', 'AuditLogPage', { q: ['page', 'limit', 'role', 'action', 'from', 'to'] }],
  'GET /api/admin/reports/:type': ['Operational report (JSON, or CSV download with ?format=csv)', 'ReportResult', { reason: true, q: ['format', 'from', 'to', 'departmentId'] }],

  // ── Admin: users ──
  'GET /api/admin/users': ['List user accounts', 'UserPage', { q: ['page', 'limit', 'search', 'role', 'status'] }],
  'PATCH /api/admin/users/:id/status': ['Activate or deactivate an account', 'UserStatus', { ex: { isActive: false } }],
  'POST /api/admin/users/:id/reset-password': ['Set a new password for an account', null, { msg: true, ex: { newPassword: 'Reset-password-1' } }],

  // ── Admin: doctors, patients, departments ──
  'GET /api/admin/doctors': ['List doctors', 'DoctorPage', { q: ['page', 'limit', 'search', 'departmentId', 'status'] }],
  'POST /api/admin/doctors': ['Create a doctor account', 'Doctor', { s: 201, conflict: true, ex: { email: 'new.doctor@example.com', password: 'Start@1234', fullName: 'Dr. Sam Rivera', specialization: 'Cardiologist', licenseNumber: 'MED-99001', qualification: 'MD', experienceYears: 6, consultationFee: 120, slotDurationMinutes: 30, departmentIds: [ID.department], primaryDepartmentId: ID.department, availability: [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }] } }],
  'GET /api/admin/doctors/:id': ['One doctor', 'Doctor'],
  'PUT /api/admin/doctors/:id': ['Update a doctor', 'Doctor', { conflict: true, ex: { specialization: 'Interventional Cardiologist', consultationFee: 140 } }],
  'DELETE /api/admin/doctors/:id': ['Delete a doctor (soft deletion: clinical history is kept)', null, { msg: true }],
  'POST /api/admin/doctors/:id/restore': ['Restore a deleted doctor', null, { msg: true }],
  'PUT /api/admin/doctors/:id/departments': ['Replace the departments of a doctor', 'Doctor', { ex: { departmentIds: [ID.department], primaryDepartmentId: ID.department } }],
  'GET /api/admin/patients': ['List patients (no clinical data)', 'PatientPage', { q: ['page', 'limit', 'search', 'status'] }],
  'POST /api/admin/patients': ['Create a patient account', 'Patient', { s: 201, conflict: true, ex: { email: 'new.patient2@example.com', password: 'Start@1234', fullName: 'Chris Lee', phone: '+1 555 0111', dateOfBirth: '1985-09-30', gender: 'MALE', bloodGroup: 'O_POS', address: '12 Example Street' } }],
  'GET /api/admin/patients/:id': ['One patient (clinical sections need an access reason)', 'AdminPatientDetail', { reason: 'unlocks' }],
  'PUT /api/admin/patients/:id': ['Update a patient\'s administrative data', 'Patient', { conflict: true, ex: { fullName: 'Chris A. Lee', phone: '+1 555 0112', address: '14 Example Street' } }],
  'GET /api/admin/departments': ['List departments', 'Department[]', { q: ['deleted'] }],
  'POST /api/admin/departments': ['Create a department', 'Department', { s: 201, conflict: true, ex: { name: 'Allergy and Immunology', description: 'Diagnosis and treatment of allergic conditions', location: '3rd Floor, Block A', phone: '+1 555 0150', icon: 'Shield', keywords: 'allergy,rash,asthma', isEmergency: false, isActive: true } }],
  'PUT /api/admin/departments/:id': ['Update a department', 'Department', { conflict: true, ex: { name: 'Allergy and Immunology', location: '3rd Floor, Block B', isActive: true } }],
  'DELETE /api/admin/departments/:id': ['Delete a department (soft deletion)', null, { msg: true }],
  'POST /api/admin/departments/:id/restore': ['Restore a deleted department', null, { msg: true }],
  'POST /api/admin/restore/:kind/:id': ['Restore a clinical item a patient deleted (reason required)', null, { reason: true, msg: true }],

  // ── Admin: appointments, emergencies, complaints, notifications ──
  'GET /api/admin/appointments': ['List appointments (no diagnosis, treatment or notes)', 'AppointmentPage', { q: ['page', 'limit', 'search', 'status', 'doctorId', 'departmentId', 'from', 'to'] }],
  'PATCH /api/admin/appointments/:id/status': ['Confirm, reject, cancel, complete or mark no-show', 'Appointment', { ex: { status: 'CONFIRMED' } }],
  'GET /api/admin/emergencies': ['List emergency requests', 'EmergencyPage', { q: ['page', 'limit', 'status', 'priority', 'departmentId'] }],
  'GET /api/admin/emergencies/:id': ['One emergency (clinical detail needs an access reason)', 'Emergency', { reason: 'unlocks' }],
  'PATCH /api/admin/emergencies/:id': ['Change priority or department, assign a doctor, re-notify', 'Emergency', { ex: { priority: 'CRITICAL', renotify: true } }],
  'POST /api/admin/emergencies/:id/acknowledge': ['Acknowledge an emergency as an administrator', 'Emergency'],
  'POST /api/admin/emergencies/:id/resolve': ['Resolve an emergency', 'Emergency', { ex: { notes: 'Patient stabilised and transferred to the ward.' } }],
  'GET /api/admin/escalation-config': ['Automatic-escalation settings (read-only)', 'EscalationConfig'],
  'GET /api/admin/complaints': ['List complaints', 'ComplaintPage', { q: ['page', 'limit', 'status', 'role'] }],
  'PATCH /api/admin/complaints/:id/respond': ['Respond to a complaint', 'Complaint', { ex: { response: 'Thank you for letting us know. We have reviewed the process.', status: 'RESOLVED' } }],
  'POST /api/admin/notifications/broadcast': ['Send a notification to a group of users', 'BroadcastResult', { s: 201, ex: { title: 'Scheduled maintenance', message: 'The portal will be unavailable on Sunday from 02:00 to 03:00.', audience: 'ALL', type: 'SYSTEM' } }],
  'GET /api/admin/notifications/broadcasts': ['Recent broadcasts', 'Broadcast[]'],
  'DELETE /api/admin/notifications/broadcasts/:id': ['Recall a broadcast (deletes its notifications)', null, { msg: true }],

  // ── Doctor ──
  'GET /api/doctor/dashboard': ['Doctor dashboard analytics', 'DoctorDashboard', { q: ['from', 'to'] }],
  'GET /api/doctor/profile': ['Your doctor profile', 'Doctor'],
  'PUT /api/doctor/profile': ['Update your profile', 'Doctor', { ex: { qualification: 'MD, FACC', bio: 'Interventional cardiologist.', isAvailableForEmergency: true } }],
  'GET /api/doctor/availability': ['Your weekly availability', 'Availability[]'],
  'PUT /api/doctor/availability': ['Replace your weekly availability', 'Availability[]', { ex: { slots: [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }, { dayOfWeek: 1, startTime: '14:00', endTime: '17:00' }] } }],
  'GET /api/doctor/appointments': ['Your appointments', 'AppointmentPage', { q: ['page', 'limit', 'search', 'status', 'scope', 'from', 'to'] }],
  'PATCH /api/doctor/appointments/:id/status': ['Confirm, reject, cancel, complete or mark no-show', 'Appointment', { ex: { status: 'CONFIRMED' } }],
  'PATCH /api/doctor/appointments/:id/consultation': ['Record diagnosis, treatment and notes', 'Appointment', { ex: { diagnosis: 'Acute bronchitis', treatment: 'Rest, fluids, paracetamol', notes: 'Review in one week', addToHistory: true } }],
  'GET /api/doctor/patients': ['Your patients (limited fields), paginated', 'DoctorPatientPage', { q: ['search', 'treating'] }],
  'GET /api/doctor/patients/:id': ['A patient\'s chart (access policy applies)', 'DoctorPatientRecord'],
  'POST /api/doctor/patients/:id/records': ['Add a medical-history entry', 'MedicalRecord', { s: 201, ex: { recordType: 'DIAGNOSIS', title: 'Hypertension', description: 'Stage 1', status: 'ACTIVE', diagnosedOn: '2026-01-15' } }],
  'POST /api/doctor/patients/:id/reports': ['Upload a medical report for a patient (multipart)', 'MedicalReport', { s: 201, multipart: true, ex: { title: 'Blood test', reportType: 'LAB', notes: 'Fasting' } }],
  'GET /api/doctor/prescriptions': ['Prescriptions you wrote', 'PrescriptionPage', { q: ['page', 'limit', 'search'] }],
  'POST /api/doctor/prescriptions': ['Write a prescription', 'Prescription', { s: 201, ex: { patientId: ID.patient, appointmentId: ID.appointment, diagnosis: 'Acute bronchitis', advice: 'Rest and fluids', followUpDate: '2026-12-01', items: [{ medicineName: 'Paracetamol', dosage: '500 mg', frequency: 'Every 6 hours as needed', durationDays: 5, instructions: 'After food' }] } }],
  'GET /api/doctor/emergencies': ['Emergencies you were alerted for', 'Emergency[]', { q: ['scope'] }],
  'POST /api/doctor/emergencies/:id/seen': ['Mark an emergency alert as seen', null],
  'POST /api/doctor/emergencies/:id/acknowledge': ['Acknowledge: you are assessing the case', 'Emergency'],
  'POST /api/doctor/emergencies/:id/accept': ['Accept the case', 'Emergency', { ex: { note: 'ETA 5 minutes' } }],
  'POST /api/doctor/emergencies/:id/escalate': ['Escalate to more specialists', 'Emergency', { ex: { reason: 'Needs a senior cardiologist' } }],
  'POST /api/doctor/emergencies/:id/resolve': ['Resolve the case', 'Emergency'],
  'GET /api/doctor/colleagues': ['Other doctors (for referrals)', 'Colleague[]'],
  'GET /api/doctor/referrals': ['Referrals received and sent', 'DoctorReferrals'],
  'POST /api/doctor/referrals': ['Refer a patient to another doctor', 'Referral', { s: 201, ex: { patientId: ID.patient, toDoctorId: ID.doctor2, reason: 'Abnormal ECG, needs a specialist opinion', notes: 'Urgent' } }],
  'PATCH /api/doctor/referrals/:id': ['Accept, decline or complete a referral', 'Referral', { ex: { status: 'ACCEPTED' } }],
  'GET /api/doctor/messages': ['Department messages (inbox, sent, your departments)', 'DoctorMessages'],
  'POST /api/doctor/messages': ['Send a message to a department', 'DoctorMessage', { s: 201, ex: { toDepartmentId: ID.department, subject: 'On-call cover', body: 'Can the department confirm on-call cover for Saturday?' } }],
  'GET /api/doctor/reviews': ['Reviews of you (paginated) with the average and rating distribution of all of them', 'DoctorReviews'],

  // ── Patient ──
  'GET /api/patient/dashboard': ['Patient dashboard', 'PatientDashboard'],
  'GET /api/patient/profile': ['Your profile', 'PatientProfile'],
  'PUT /api/patient/profile': ['Update your profile', 'PatientProfile', { ex: { phone: '+1 555 0101', heightCm: 172, weightKg: 70, bloodGroup: 'A_POS', emergencyContactName: 'Sam Doe', emergencyContactPhone: '+1 555 0102' } }],
  'GET /api/patient/appointments': ['Your appointments', 'AppointmentPage', { q: ['page', 'limit', 'status', 'scope'] }],
  'POST /api/patient/appointments': ['Book an appointment', 'Appointment', { s: 201, conflict: true, ex: { doctorId: ID.doctor, startAt: '2030-01-15T09:00:00.000Z', reason: 'Back pain', type: 'CONSULTATION' } }],
  'PATCH /api/patient/appointments/:id/cancel': ['Cancel an appointment', 'Appointment', { ex: { reason: 'I can no longer attend' } }],
  'PATCH /api/patient/appointments/:id/reschedule': ['Move an appointment to another slot', 'Appointment', { conflict: true, ex: { startAt: '2030-01-16T09:00:00.000Z' } }],
  'GET /api/patient/medical-records': ['Your medical history', 'MedicalRecord[]', { q: ['deleted'] }],
  'POST /api/patient/medical-records': ['Add a history entry', 'MedicalRecord', { s: 201, ex: { recordType: 'CONDITION', title: 'Seasonal asthma', description: 'Mild, in spring', status: 'ACTIVE', diagnosedOn: '2024-03-01' } }],
  'PUT /api/patient/medical-records/:id': ['Update a history entry', 'MedicalRecord', { ex: { recordType: 'CONDITION', title: 'Seasonal asthma', status: 'RESOLVED' } }],
  'DELETE /api/patient/medical-records/:id': ['Delete a history entry (soft deletion)', null],
  'POST /api/patient/medical-records/:id/restore': ['Restore a deleted history entry', null],
  'GET /api/patient/allergies': ['Your allergies', 'Allergy[]', { q: ['deleted'] }],
  'POST /api/patient/allergies': ['Add an allergy', 'Allergy', { s: 201, ex: { allergen: 'Penicillin', type: 'DRUG', severity: 'SEVERE', reaction: 'Rash', notes: 'Since childhood' } }],
  'PUT /api/patient/allergies/:id': ['Update an allergy', 'Allergy', { ex: { allergen: 'Penicillin', type: 'DRUG', severity: 'MODERATE' } }],
  'DELETE /api/patient/allergies/:id': ['Delete an allergy (soft deletion)', null],
  'POST /api/patient/allergies/:id/restore': ['Restore a deleted allergy', null],
  'GET /api/patient/reports': ['Your uploaded reports, paginated', 'MedicalReportPage', { q: ['deleted'] }],
  'POST /api/patient/reports': ['Upload a medical report (multipart)', 'MedicalReport', { s: 201, multipart: true, ex: { title: 'Chest X-ray', reportType: 'IMAGING', notes: 'March 2026' } }],
  'DELETE /api/patient/reports/:id': ['Delete a report (soft deletion; the file is kept)', null],
  'POST /api/patient/reports/:id/restore': ['Restore a deleted report', null],
  'GET /api/patient/prescriptions': ['Your prescriptions, paginated', 'PrescriptionPage'],
  'GET /api/patient/emergencies': ['Your emergency requests', 'Emergency[]'],
  'POST /api/patient/emergencies': ['Send an emergency request', 'Emergency', { s: 201, conflict: true, ex: { priority: 'HIGH', symptoms: 'Sudden chest pain and dizziness', locationConsent: false } }],
  'POST /api/patient/emergencies/:id/cancel': ['Cancel your active emergency request', 'Emergency'],
  'GET /api/patient/reviews': ['Reviews you wrote, paginated', 'ReviewPage'],
  'POST /api/patient/reviews': ['Review a completed appointment', 'Review', { s: 201, conflict: true, ex: { appointmentId: ID.appointment, rating: 5, comment: 'Clear explanations and no waiting.' } }],
};

module.exports = { routes: r, ID, Q };
