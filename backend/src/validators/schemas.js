const { z } = require('zod');

// '' -> null so optional form fields can be cleared
const blankToNull = (v) => (v === '' ? null : v);
const optStr = (max = 255) => z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());
const reqStr = (min = 1, max = 255) => z.string().trim().min(min, `Must be at least ${min} character(s)`).max(max);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD format');
const optDate = z.preprocess(blankToNull, dateStr.nullable().optional());
const uuid = z.string().uuid('Invalid id');
const optUuid = z.preprocess(blankToNull, uuid.nullable().optional());
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h) format');
const email = z.string().trim().toLowerCase().email('Invalid email address').max(255);
const password = z.string().min(8, 'Password must be at least 8 characters').max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter').regex(/\d/, 'Password must contain a number');
const phone = z.preprocess(blankToNull, z.string().trim().regex(/^[+\d][\d\s()-]{5,29}$/, 'Invalid phone number').nullable().optional());
const optNum = (min, max) => z.preprocess((v) => (v === '' || v === null || v === undefined ? null : Number(v)), z.number().min(min).max(max).nullable().optional());
const bool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

const GENDER = z.enum(['MALE', 'FEMALE', 'OTHER']);
const BLOOD = z.enum(['A_POS', 'A_NEG', 'B_POS', 'B_NEG', 'AB_POS', 'AB_NEG', 'O_POS', 'O_NEG']);
const optEnum = (e) => z.preprocess(blankToNull, e.nullable().optional());
const PRIORITY = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);

const idParam = z.object({ id: uuid });

// ?page and ?limit of every paginated list: whole numbers, page >= 1 (at most 1,000,000), limit 1-100 (default 20). Anything else is a 400.
const pageParam = z.coerce.number({ message: 'page must be a whole number' }).int('page must be a whole number').min(1, 'page must be at least 1').max(1000000, 'page is too large');
const limitParam = z.coerce.number({ message: 'limit must be a whole number' }).int('limit must be a whole number').min(1, 'limit must be at least 1').max(100, 'limit must be at most 100');
const pageQuery = z.object({ page: pageParam.optional(), limit: limitParam.optional() }).passthrough();

const listQuery = z.object({
  page: pageParam.optional(),
  limit: limitParam.optional(),
  search: z.string().trim().max(100).optional(),
  status: z.string().trim().max(30).optional(),
  priority: z.string().trim().max(30).optional(),
  role: z.string().trim().max(30).optional(),
  departmentId: z.preprocess(blankToNull, uuid.nullable().optional()),
  doctorId: z.preprocess(blankToNull, uuid.nullable().optional()),
  from: z.preprocess(blankToNull, dateStr.nullable().optional()),
  to: z.preprocess(blankToNull, dateStr.nullable().optional()),
  action: z.string().trim().max(100).optional(),
  type: z.string().trim().max(40).optional(),
  scope: z.string().trim().max(30).optional(),
  format: z.enum(['json', 'csv']).optional(),
}).passthrough();

const availabilityItem = z.object({ dayOfWeek: z.coerce.number().int().min(0).max(6), startTime: hhmm, endTime: hhmm })
  .refine((a) => a.endTime > a.startTime, { message: 'End time must be after start time' });

const auth = {
  register: z.object({
    email, password, fullName: reqStr(2, 150), phone, dateOfBirth: optDate, gender: optEnum(GENDER),
  }),
  login: z.object({ email, password: z.string().min(1, 'Password is required').max(128) }),
  changePassword: z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }),
};

const doctorBase = {
  fullName: reqStr(2, 150),
  phone,
  gender: optEnum(GENDER),
  specialization: reqStr(2, 150),
  qualification: optStr(255),
  experienceYears: z.coerce.number().int().min(0).max(80).default(0),
  consultationFee: z.coerce.number().min(0).max(1000000).default(0),
  licenseNumber: reqStr(3, 80),
  bio: optStr(5000),
  avatarUrl: z.preprocess(blankToNull, z.string().url().max(500).nullable().optional()),
  slotDurationMinutes: z.coerce.number().int().min(5).max(240).default(30),
  isAvailableForEmergency: bool.default(true),
  departmentIds: z.array(uuid).default([]),
  primaryDepartmentId: optUuid,
};

const admin = {
  createDoctor: z.object({ email, password, ...doctorBase, availability: z.array(availabilityItem).optional() }),
  updateDoctor: z.object({ email: email.optional(), ...doctorBase }).partial(),
  assignDepartments: z.object({ departmentIds: z.array(uuid), primaryDepartmentId: optUuid }),
  createPatient: z.object({
    email, password, fullName: reqStr(2, 150), phone, dateOfBirth: optDate, gender: optEnum(GENDER), bloodGroup: optEnum(BLOOD), address: optStr(500),
  }),
  updatePatient: z.object({
    // blood group is entered at registration only (createPatient); updates never touch it
    email: email.optional(), fullName: reqStr(2, 150).optional(), phone, dateOfBirth: optDate, gender: optEnum(GENDER),
    address: optStr(500), emergencyContactName: optStr(150), emergencyContactPhone: phone,
  }),
  department: z.object({
    name: reqStr(2, 120), description: optStr(5000), location: optStr(150), phone, icon: optStr(50), keywords: optStr(2000),
    isEmergency: bool.default(false), isActive: bool.default(true), headDoctorId: optUuid,
  }),
  appointmentStatus: z.object({ status: z.enum(['CONFIRMED', 'REJECTED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']), reason: optStr(1000) }),
  emergencyUpdate: z.object({
    priority: PRIORITY.optional(), departmentId: optUuid, assignDoctorId: optUuid, renotify: z.boolean().optional(),
  }),
  resolve: z.object({ notes: optStr(2000) }),
  complaintRespond: z.object({ response: reqStr(2, 5000), status: z.enum(['IN_PROGRESS', 'RESOLVED', 'CLOSED']) }),
  userStatus: z.object({ isActive: z.boolean() }),
  resetPassword: z.object({ newPassword: password }),
  broadcast: z.object({
    title: reqStr(2, 200), message: reqStr(2, 2000), audience: z.enum(['ALL', 'ADMIN', 'DOCTOR', 'PATIENT']),
    type: z.enum(['SYSTEM', 'APPOINTMENT', 'EMERGENCY', 'MESSAGE']).default('SYSTEM'),
  }),
};

const doctor = {
  profile: z.object({
    fullName: reqStr(2, 150).optional(), phone, qualification: optStr(255), bio: optStr(5000),
    avatarUrl: z.preprocess(blankToNull, z.string().url().max(500).nullable().optional()),
    consultationFee: z.coerce.number().min(0).max(1000000).optional(),
    slotDurationMinutes: z.coerce.number().int().min(5).max(240).optional(),
    isAvailableForEmergency: bool.optional(),
  }),
  availability: z.object({ slots: z.array(availabilityItem).max(50) })
    .refine((v) => {
      // no overlapping blocks on the same day
      const byDay = {};
      for (const s of v.slots) (byDay[s.dayOfWeek] ||= []).push(s);
      return Object.values(byDay).every((arr) => arr.sort((a, b) => a.startTime.localeCompare(b.startTime))
        .every((s, i) => i === 0 || s.startTime >= arr[i - 1].endTime));
    }, { message: 'Availability blocks on the same day must not overlap' }),
  appointmentStatus: z.object({ status: z.enum(['CONFIRMED', 'REJECTED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']), reason: optStr(1000) }),
  consultation: z.object({ diagnosis: optStr(5000), treatment: optStr(5000), notes: optStr(5000), addToHistory: z.boolean().optional() }),
  prescription: z.object({
    patientId: uuid, appointmentId: optUuid, diagnosis: reqStr(2, 5000), advice: optStr(5000), followUpDate: optDate,
    items: z.array(z.object({
      medicineName: reqStr(1, 200), dosage: reqStr(1, 100), frequency: reqStr(1, 100),
      durationDays: z.coerce.number().int().min(1).max(365), instructions: optStr(500),
    })).min(1, 'Add at least one medicine').max(30),
  }),
  record: z.object({
    recordType: z.enum(['CONDITION', 'DIAGNOSIS', 'SURGERY', 'MEDICATION', 'FAMILY_HISTORY', 'VACCINATION', 'OTHER']),
    title: reqStr(2, 200), description: optStr(5000), status: z.enum(['ACTIVE', 'RESOLVED']).default('ACTIVE'), diagnosedOn: optDate, appointmentId: optUuid,
  }),
  emergencyAccept: z.object({ note: optStr(1000) }),
  emergencyEscalate: z.object({ reason: reqStr(3, 2000) }),
  referral: z.object({ patientId: uuid, toDoctorId: uuid, departmentId: optUuid, reason: reqStr(3, 2000), notes: optStr(5000) }),
  referralStatus: z.object({ status: z.enum(['ACCEPTED', 'DECLINED', 'COMPLETED']) }),
  message: z.object({ toDepartmentId: uuid, fromDepartmentId: optUuid, subject: reqStr(2, 200), body: reqStr(2, 5000) }),
};

const patient = {
  profile: z.object({
    fullName: reqStr(2, 150).optional(), phone, dateOfBirth: optDate, gender: optEnum(GENDER), bloodGroup: optEnum(BLOOD), address: optStr(500),
    heightCm: optNum(20, 300), weightKg: optNum(0.5, 700), emergencyContactName: optStr(150), emergencyContactPhone: phone,
  }),
  book: z.object({
    doctorId: uuid, departmentId: optUuid, startAt: z.string().datetime({ offset: true, message: 'Invalid start time' }),
    reason: optStr(2000), type: z.enum(['CONSULTATION', 'FOLLOW_UP']).default('CONSULTATION'),
  }),
  reschedule: z.object({ startAt: z.string().datetime({ offset: true, message: 'Invalid start time' }) }),
  cancel: z.object({ reason: optStr(1000) }),
  record: doctor.record.omit({ appointmentId: true }),
  allergy: z.object({
    allergen: reqStr(1, 150), type: z.enum(['DRUG', 'FOOD', 'ENVIRONMENTAL', 'OTHER']),
    severity: z.enum(['MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING']).default('MODERATE'), reaction: optStr(255), notes: optStr(2000),
  }),
  emergency: z.object({
    priority: PRIORITY, symptoms: reqStr(5, 2000), description: optStr(5000), departmentId: optUuid, contactPhone: phone,
    locationConsent: z.boolean().default(false),
    latitude: optNum(-90, 90), longitude: optNum(-180, 180), address: optStr(500),
  }).refine((v) => v.locationConsent || (v.latitude == null && v.longitude == null), {
    message: 'Location can only be shared with consent', path: ['locationConsent'],
  }),
  review: z.object({ appointmentId: uuid, rating: z.coerce.number().int().min(1).max(5), comment: optStr(2000) }),
};

const report = z.object({
  title: reqStr(2, 200), reportType: z.enum(['LAB', 'IMAGING', 'CONSULTATION', 'DISCHARGE', 'OTHER']), notes: optStr(2000), appointmentId: optUuid,
});

const complaint = z.object({
  subject: reqStr(3, 200), description: reqStr(10, 5000),
  category: z.enum(['SERVICE', 'DOCTOR', 'BILLING', 'FACILITY', 'APPOINTMENT', 'TECHNICAL', 'OTHER']).default('OTHER'),
  againstDoctorId: optUuid,
});

const contact = z.object({ name: reqStr(2, 150), email, subject: reqStr(3, 200), message: reqStr(10, 5000) });

module.exports = { idParam, listQuery, pageQuery, pageParam, limitParam, auth, admin, doctor, patient, report, complaint, contact, z };
