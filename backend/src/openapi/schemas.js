// Reusable OpenAPI components (response schemas, envelopes, errors).
// Request schemas are NOT written here: they are generated from the zod validators the API really uses (src/validators/schemas.js).
// Response schemas describe what the services return (Prisma selects/includes). tests/openapi.test.js calls the live API and validates
// the real responses against these schemas, so a drifting shape fails the test. Dates are ISO-8601 strings in UTC; Prisma Decimal
// columns (fees, height, weight, coordinates) are serialised as strings.
const P = require('@prisma/client');

const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const en = (o) => ({ type: 'string', enum: Object.values(o) });
const S = { type: 'string' }; const NS = { type: ['string', 'null'] };
const N = { type: 'number' }; const NN = { type: ['number', 'null'] };
const I = { type: 'integer' }; const B = { type: 'boolean' };
const ID = { type: 'string', format: 'uuid' }; const NID = { type: ['string', 'null'], format: 'uuid' };
const DT = { type: 'string', format: 'date-time' }; const NDT = { type: ['string', 'null'], format: 'date-time' };
const DEC = { type: 'string', description: 'Decimal number serialised as a string', examples: ['150'] };
const NDEC = { type: ['string', 'null'], description: 'Decimal number serialised as a string' };
const arr = (items) => ({ type: 'array', items });
/** object schema; every property is required unless listed in `optional` */
const obj = (properties, optional = []) => ({ type: 'object', properties, required: Object.keys(properties).filter((k) => !optional.includes(k)) });
const page = (item, extra = {}, extraOptional = []) => obj({ items: arr(item), pagination: ref('Pagination'), ...extra }, extraOptional);
const nameOnly = obj({ id: ID, fullName: S }, ['id']);
const count = (...keys) => obj(Object.fromEntries(keys.map((k) => [k, I])));
const series = (...extra) => arr(obj({ date: S, ...Object.fromEntries(extra.map((k) => [k, I])) }));
const nameValue = arr(obj({ name: S, value: N }));

const schemas = {
  // ── Envelopes ──
  Success: { type: 'object', description: 'Every successful JSON response. `data` carries the payload and is omitted when there is nothing to return.', required: ['success'], properties: { success: { const: true }, message: { type: 'string', description: 'Optional human-readable confirmation' } } },
  Pagination: {
    type: 'object', description: 'Position within a paginated list. `page` and `limit` echo the request (defaults 1 and 20; `limit` at most 100). A page past the end returns empty `items` with the real `totalItems`. `total` repeats `totalItems` for older clients (deprecated).',
    required: ['page', 'limit', 'totalItems', 'totalPages', 'hasNextPage', 'hasPreviousPage'],
    properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, totalItems: { type: 'integer', minimum: 0, description: 'Number of items matching the filters, across all pages' }, totalPages: { type: 'integer', minimum: 0, description: '0 when nothing matches' }, hasNextPage: B, hasPreviousPage: B, total: { type: 'integer', deprecated: true, description: 'Deprecated: use totalItems' } },
    examples: [{ page: 1, limit: 20, totalItems: 45, totalPages: 3, hasNextPage: true, hasPreviousPage: false, total: 45 }, { page: 2, limit: 20, totalItems: 45, totalPages: 3, hasNextPage: true, hasPreviousPage: true, total: 45 }, { page: 3, limit: 20, totalItems: 45, totalPages: 3, hasNextPage: false, hasPreviousPage: true, total: 45 }, { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false, total: 0 }],
  },
  ErrorCode: { type: 'string', description: 'Stable machine-readable error code. Branch on this, never on `message`.', enum: ['VALIDATION_ERROR', 'BAD_REQUEST', 'MALFORMED_JSON', 'UPLOAD_ERROR', 'REASON_REQUIRED', 'EXPORT_RANGE_TOO_LARGE', 'EXPORT_RANGE_INVALID', 'DATABASE_REQUEST_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'PAYLOAD_TOO_LARGE', 'RATE_LIMITED', 'ACCOUNT_LOCKED', 'INTERNAL_ERROR'] },
  ValidationDetail: obj({ field: S, message: S }),
  ErrorResponse: {
    type: 'object', description: 'Every error response. Stack traces, SQL, file paths, request bodies, tokens and clinical data never appear in it. `details` repeats `error.details` for older clients (deprecated).',
    required: ['success', 'message', 'error', 'requestId'],
    properties: {
      success: { const: false }, message: { type: 'string', description: 'Safe text that may be shown to the user' },
      error: { type: 'object', required: ['code', 'status'], properties: { code: ref('ErrorCode'), status: { type: 'integer' }, details: { description: 'VALIDATION_ERROR: array of {field, message}. REASON_REQUIRED: {code, minLength, maxLength}. ACCOUNT_LOCKED: {retryAfterSeconds}.', anyOf: [arr(ref('ValidationDetail')), { type: 'object' }] } } },
      details: { deprecated: true, description: 'Deprecated legacy copy of error.details' },
      requestId: { type: 'string', description: 'Same value as the X-Request-Id response header; quote it to find the cause in the server log' },
    },
  },
  MessageOnly: { allOf: [ref('Success')], description: 'Success with only a confirmation message (no data)' },

  // ── Authentication, users and roles ──
  Role: en(P.Role),
  Gender: en(P.Gender), BloodGroup: en(P.BloodGroup),
  AdminProfile: obj({ id: ID, userId: ID, fullName: S, phone: NS, designation: NS, createdAt: DT, updatedAt: DT }),
  SessionUser: { type: 'object', description: 'The signed-in account. `profile` is the admin, doctor or patient record of the user (its fields depend on `role`).', required: ['id', 'email', 'role', 'isActive', 'createdAt'], properties: { id: ID, email: { type: 'string', format: 'email' }, role: ref('Role'), isActive: B, lastLoginAt: NDT, createdAt: DT, profile: { type: ['object', 'null'], required: ['id', 'fullName'], properties: { id: ID, userId: ID, fullName: S, phone: NS } } } },
  Session: obj({ token: { type: 'string', description: 'JWT. Send as `Authorization: Bearer <token>`' }, user: ref('SessionUser') }),
  TokenOnly: obj({ token: { type: 'string', description: 'A fresh JWT; the previous tokens of the account stop working' } }),
  CurrentUser: obj({ user: ref('SessionUser') }),
  User: obj({ id: ID, email: S, role: ref('Role'), isActive: B, lastLoginAt: NDT, createdAt: DT, admin: { type: ['object', 'null'] }, doctor: { type: ['object', 'null'], properties: { id: ID, fullName: S } }, patient: { type: ['object', 'null'], properties: { id: ID, fullName: S } } }, ['admin', 'doctor', 'patient']),
  UserStatus: obj({ id: ID, email: S, isActive: B, role: ref('Role') }),
  Health: obj({ status: { const: 'ok' }, time: DT }),

  // ── Directory (public) ──
  PublicStats: obj({ doctors: I, patients: I, departments: I, completedAppointments: I, avgRating: N }),
  PublicDepartment: obj({ id: ID, name: S, description: NS, location: NS, phone: NS, icon: NS, isEmergency: B, headDoctor: { type: ['object', 'null'], properties: { id: ID, fullName: S } }, _count: count('doctors') }, ['_count']),
  PublicDoctor: obj({ id: ID, fullName: S, gender: { anyOf: [ref('Gender'), { type: 'null' }] }, specialization: S, qualification: NS, experienceYears: I, consultationFee: DEC, bio: NS, avatarUrl: NS, slotDurationMinutes: I, departments: arr({ type: 'object' }), rating: N, reviewCount: I, availableDays: arr(I) }, ['availableDays']),
  PublicDepartmentDetail: { allOf: [ref('PublicDepartment'), obj({ doctors: arr(ref('PublicDoctor')) })] },
  PublicDoctorDetail: { allOf: [ref('PublicDoctor'), obj({ availability: arr(obj({ dayOfWeek: I, startTime: S, endTime: S })), reviews: arr(obj({ id: ID, rating: I, comment: NS, createdAt: DT, patient: { type: 'object' } })) }, [])] },
  Slots: obj({ doctorId: ID, date: S, slotDurationMinutes: I, slots: arr(obj({ time: S, startAt: DT, endAt: DT, available: B, booked: B })) }),

  // ── Departments, doctors, patients ──
  Department: obj({ id: ID, name: S, description: NS, location: NS, phone: NS, icon: NS, keywords: NS, isEmergency: B, isActive: B, headDoctorId: NID, createdAt: DT, updatedAt: DT, deletedAt: NDT, deletedByUserId: NID, headDoctor: { type: ['object', 'null'] }, doctors: arr({ type: 'object' }), _count: { type: 'object' } }, ['headDoctor', 'doctors', '_count']),
  Availability: obj({ id: ID, doctorId: ID, dayOfWeek: I, startTime: S, endTime: S, isActive: B, createdAt: DT, updatedAt: DT }),
  Doctor: obj({ id: ID, userId: ID, fullName: S, phone: NS, gender: { anyOf: [ref('Gender'), { type: 'null' }] }, specialization: S, qualification: NS, experienceYears: I, consultationFee: DEC, licenseNumber: S, bio: NS, avatarUrl: NS, slotDurationMinutes: I, isAvailableForEmergency: B, createdAt: DT, updatedAt: DT, deletedAt: NDT, deletedByUserId: NID, user: { type: 'object', properties: { email: S, isActive: B } }, departments: arr({ type: 'object' }), availability: arr(ref('Availability')), _count: { type: 'object' } }, ['user', 'departments', 'availability', '_count']),
  Patient: obj({ id: ID, userId: ID, fullName: S, phone: NS, dateOfBirth: NDT, gender: { anyOf: [ref('Gender'), { type: 'null' }] }, address: NS, emergencyContactName: NS, emergencyContactPhone: NS, createdAt: DT, updatedAt: DT, user: { type: 'object', properties: { email: S, isActive: B } }, _count: { type: 'object' } }, ['user', '_count']),
  PatientProfile: obj({ id: ID, userId: ID, fullName: S, phone: NS, dateOfBirth: NDT, gender: { anyOf: [ref('Gender'), { type: 'null' }] }, bloodGroup: { anyOf: [ref('BloodGroup'), { type: 'null' }] }, address: NS, heightCm: NDEC, weightKg: NDEC, emergencyContactName: NS, emergencyContactPhone: NS, createdAt: DT, updatedAt: DT, user: { type: 'object', properties: { email: S } } }, ['user']),
  AdminPatientDetail: { description: 'Administrators receive the clinical sections only with a recorded access reason (X-Access-Reason); otherwise `clinicalWithheld` is true and the clinical arrays are empty or absent.', allOf: [ref('Patient'), obj({ clinicalWithheld: B, bloodGroup: { anyOf: [ref('BloodGroup'), { type: 'null' }] }, heightCm: NDEC, weightKg: NDEC, allergies: arr(ref('Allergy')), medicalRecords: arr(ref('MedicalRecord')), appointments: arr({ type: 'object' }), emergencyRequests: arr({ type: 'object' }) }, ['bloodGroup', 'heightCm', 'weightKg', 'allergies', 'medicalRecords', 'appointments', 'emergencyRequests'])] },
  DoctorPatientListItem: obj({ id: ID, fullName: S, gender: { anyOf: [ref('Gender'), { type: 'null' }] }, dateOfBirth: NDT, phone: NS, appointments: arr(obj({ startAt: DT, status: S })), bloodGroup: { anyOf: [ref('BloodGroup'), { type: 'null' }] }, _count: { type: 'object' } }, ['bloodGroup', '_count']),
  DoctorPatientRecord: { description: 'A patient\'s chart as seen by a doctor. `access` states why the doctor may see it (TREATMENT, EMERGENCY, HISTORICAL) and whether they may write.', allOf: [ref('PatientProfile'), obj({ medicalRecords: arr(ref('MedicalRecord')), prescriptions: arr(ref('Prescription')), medicalReports: arr(ref('MedicalReport')), appointments: arr({ type: 'object' }), emergencyRequests: arr({ type: 'object' }), allergies: arr(ref('Allergy')), access: obj({ level: S, bases: arr(S), canWrite: B, sections: { type: 'object' } }) }, [])] },

  // ── Appointments ──
  AppointmentStatus: en(P.AppointmentStatus), AppointmentType: en(P.AppointmentType),
  Appointment: obj({
    id: ID, patientId: ID, doctorId: ID, departmentId: ID, startAt: DT, endAt: DT, status: ref('AppointmentStatus'), type: ref('AppointmentType'), reason: NS,
    notes: { type: ['string', 'null'], description: 'Clinical notes: never sent to administrators' }, diagnosis: { type: ['string', 'null'], description: 'Never sent to administrators' }, treatment: { type: ['string', 'null'], description: 'Never sent to administrators' },
    statusReason: NS, approvedByAdmin: B, rescheduledCount: I, completedAt: NDT, cancelledAt: NDT, createdAt: DT, updatedAt: DT,
    patient: { type: 'object', properties: { id: ID, fullName: S } }, doctor: { type: 'object', properties: { id: ID, fullName: S, specialization: S } }, department: { type: 'object', properties: { id: ID, name: S } }, review: { type: ['object', 'null'] }, prescriptions: arr({ type: 'object' }),
  }, ['notes', 'diagnosis', 'treatment', 'patient', 'doctor', 'department', 'review', 'prescriptions']),

  // ── Medical records, allergies, prescriptions, reports ──
  MedicalRecordType: en(P.MedicalRecordType), RecordStatus: en(P.RecordStatus), AllergyType: en(P.AllergyType), AllergySeverity: en(P.AllergySeverity), ReportType: en(P.ReportType),
  MedicalRecord: obj({ id: ID, patientId: ID, appointmentId: NID, createdByUserId: ID, recordType: ref('MedicalRecordType'), title: S, description: NS, status: ref('RecordStatus'), diagnosedOn: NDT, createdAt: DT, updatedAt: DT, deletedAt: NDT, deletedByUserId: NID, createdBy: { type: 'object' } }, ['createdBy']),
  Allergy: obj({ id: ID, patientId: ID, allergen: S, type: ref('AllergyType'), severity: ref('AllergySeverity'), reaction: NS, notes: NS, createdAt: DT, updatedAt: DT, deletedAt: NDT, deletedByUserId: NID }),
  PrescriptionItem: obj({ id: ID, prescriptionId: ID, medicineName: S, dosage: S, frequency: S, durationDays: I, instructions: NS, createdAt: DT, updatedAt: DT }),
  Prescription: obj({ id: ID, prescriptionNumber: S, appointmentId: NID, doctorId: ID, patientId: ID, diagnosis: S, advice: NS, followUpDate: NDT, createdAt: DT, updatedAt: DT, items: arr(ref('PrescriptionItem')), doctor: { type: 'object' }, patient: { type: 'object' }, appointment: { type: ['object', 'null'] } }, ['doctor', 'patient', 'appointment']),
  MedicalReport: { description: 'An uploaded report (metadata; the file itself is downloaded from GET /files/reports/{id}). `fileName` is the original name; `storedName` is the opaque random name the file has in storage (never a path).', ...obj({ id: ID, patientId: ID, doctorId: NID, appointmentId: NID, uploadedByUserId: ID, title: S, reportType: ref('ReportType'), notes: NS, fileName: S, storedName: S, mimeType: S, fileSize: I, createdAt: DT, updatedAt: DT, deletedAt: NDT, deletedByUserId: NID, doctor: { type: ['object', 'null'] }, uploadedBy: { type: 'object' } }, ['doctor', 'uploadedBy', 'deletedAt', 'deletedByUserId']) },

  // ── Emergencies ──
  EmergencyPriority: en(P.EmergencyPriority), EmergencyStatus: en(P.EmergencyStatus),
  Emergency: obj({
    id: ID, patientId: ID, departmentId: NID, assignedDoctorId: NID, priority: ref('EmergencyPriority'), status: ref('EmergencyStatus'), symptoms: S, description: NS, contactPhone: NS, locationConsent: B, latitude: NDEC, longitude: NDEC, address: NS,
    escalationLevel: I, escalationReason: NS, autoEscalationEnabled: B, autoEscalationLevel: I, nextEscalationAt: NDT, acknowledgedAt: NDT, acknowledgedByUserId: NID, acknowledgedLevel: { type: ['integer', 'null'] }, resolutionNotes: NS,
    notifiedAt: NDT, acceptedAt: NDT, resolvedAt: NDT, createdAt: DT, updatedAt: DT,
    patient: { type: 'object', properties: { id: ID, fullName: S } }, department: { type: ['object', 'null'] }, assignedDoctor: { type: ['object', 'null'] }, notifications: arr({ type: 'object' }), events: arr({ type: 'object' }), escalations: arr({ type: 'object' }),
  }, ['patient', 'department', 'assignedDoctor', 'notifications', 'events', 'escalations']),
  EscalationConfig: obj({ enabled: B, reason: NS, production: B, approvalRef: NS, targetsMinutes: obj({ CRITICAL: N, HIGH: N, MEDIUM: N, LOW: N }), maxLevel: I, pollSeconds: N, levels: { type: 'object', additionalProperties: S }, note: S }),

  // ── Notifications, complaints, referrals, messages, reviews ──
  NotificationType: en(P.NotificationType),
  Notification: obj({ id: ID, userId: ID, type: ref('NotificationType'), title: S, message: S, link: NS, isRead: B, readAt: NDT, broadcastId: NID, createdAt: DT, updatedAt: DT }),
  Complaint: obj({ id: ID, complainantUserId: NID, guestName: NS, guestEmail: NS, againstDoctorId: NID, category: en(P.ComplaintCategory), subject: S, description: S, status: en(P.ComplaintStatus), response: NS, respondedByUserId: NID, respondedAt: NDT, createdAt: DT, updatedAt: DT }, []),
  Referral: obj({ id: ID, patientId: ID, fromDoctorId: ID, toDoctorId: ID, departmentId: NID, appointmentId: NID, reason: S, notes: NS, status: en(P.ReferralStatus), createdAt: DT, updatedAt: DT }, []),
  DoctorMessage: obj({ id: ID, senderDoctorId: ID, fromDepartmentId: NID, toDepartmentId: ID, subject: S, body: S, createdAt: DT, updatedAt: DT }, []),
  Review: obj({ id: ID, doctorId: ID, patientId: ID, appointmentId: ID, rating: I, comment: NS, isVisible: B, createdAt: DT, updatedAt: DT }),

  // ── Dashboards, activity, audit, reports ──
  AdminDashboard: obj({ range: obj({ from: S, to: S, granularity: S }), totals: { type: 'object', additionalProperties: N }, appointmentsByStatus: nameValue, appointmentTrend: series('total', 'completed', 'cancelled', 'pending'), registrationTrend: series('patients'), emergencyTrend: series('emergencies'), emergenciesByPriority: nameValue, emergenciesByStatus: nameValue, departmentStats: arr({ type: 'object' }), doctorPerformance: arr({ type: 'object' }), satisfaction: { type: 'object' }, recentEmergencies: arr({ type: 'object' }), recentAppointments: arr(ref('Appointment')) }),
  DoctorDashboard: obj({ range: obj({ from: S, to: S, granularity: S }), totals: { type: 'object', additionalProperties: N }, appointmentsByStatus: nameValue, appointmentTrend: series('total', 'completed', 'cancelled'), weekdayDistribution: nameValue, emergenciesByPriority: nameValue, ratingDistribution: nameValue, todaysAppointments: arr(ref('Appointment')), pendingRequests: arr(ref('Appointment')), activeEmergencies: arr({ type: 'object' }) }),
  PatientDashboard: obj({ upcoming: arr(ref('Appointment')), activeEmergency: { type: ['object', 'null'] }, recentPrescriptions: arr({ type: 'object' }), unreadNotifications: I, allergies: arr(ref('Allergy')), pendingReviews: I, profileCompleteness: N, stats: { type: 'object', additionalProperties: I } }),
  AuditLog: obj({ id: ID, seq: I, userId: NID, userRole: { anyOf: [ref('Role'), { type: 'null' }] }, action: S, entityType: NS, entityId: NS, details: { description: 'Metadata only; never clinical text', type: ['object', 'null'] }, ipAddress: NS, userAgent: NS, createdAt: DT, updatedAt: DT, user: { type: ['object', 'null'] } }, ['user']),
  ReportResult: { description: 'A tabular report. With ?format=csv the same data is downloaded as text/csv instead (see the operation\'s second response).', ...obj({ type: S, from: S, to: S, columns: arr(S), rows: arr(arr({})), total: I }) },
  BroadcastResult: obj({ broadcastId: ID, recipients: I }),
  Broadcast: { description: 'A sent broadcast, from the audit log; the audit details (audience, title, type, recipients) are included.', ...obj({ id: ID, sentBy: NS, createdAt: DT, readCount: I, audience: S, title: S, type: S, recipients: I }, ['audience', 'title', 'type', 'recipients']) },
  UpdatedCount: obj({ updated: I }),
};

// Response bodies that are paged or have extra top-level fields
Object.assign(schemas, {
  AppointmentPage: page(ref('Appointment')),
  EmergencyPage: page(ref('Emergency')),
  ComplaintPage: page(ref('Complaint'), {}, []),
  DoctorPage: page(ref('Doctor')), PatientPage: page(ref('Patient')), UserPage: page(ref('User')),
  PrescriptionPage: page(ref('Prescription')),
  NotificationPage: page(ref('Notification'), { unread: I }),
  AuditLogPage: page(ref('AuditLog'), { actions: arr(S) }),
  ActivityFeed: page(ref('AuditLog'), { byAction: nameValue, mostActive: arr(obj({ id: ID, role: ref('Role'), email: S, doctor: { type: ['object', 'null'] }, patient: { type: ['object', 'null'] }, actions: I })) }),
  DoctorMessages: obj({ inbox: arr(ref('DoctorMessage')), sent: arr(ref('DoctorMessage')), myDepartments: arr(ref('Department')) }),
  DoctorReferrals: obj({ received: arr(ref('Referral')), sent: arr(ref('Referral')) }),
  DoctorReviews: page(ref('DoctorReview'), { average: NN, total: I, distribution: arr(obj({ rating: I, count: I })) }),
  DoctorReview: { allOf: [ref('Review'), obj({ patient: { type: 'object', properties: { fullName: S } }, appointment: { type: 'object', properties: { startAt: DT } } })] },
  ReviewPage: page(ref('PatientReview')),
  PatientReview: { allOf: [ref('Review'), obj({ doctor: { type: 'object', properties: { fullName: S, specialization: S } } })] },
  MedicalReportPage: page(ref('MedicalReport')),
  DoctorPatientPage: page(ref('DoctorPatientListItem')),
  Colleague: obj({ id: ID, fullName: S, specialization: S, departments: arr({ type: 'object' }) }),
});

module.exports = { schemas, ref };
