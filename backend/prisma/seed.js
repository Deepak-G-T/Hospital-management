/* eslint-disable no-console */
// Seeds the database with an admin, departments, doctors, patients and realistic
// historical activity so every dashboard and chart has data to work with.
// Run: npm run db:seed   (re-runnable on a demo database — it wipes and recreates all data)
// Guarded: refuses in production or on a database that looks like real data (see prisma/seed-guard.js).
// Connects as the SEEDER role (SEED_DATABASE_URL): it is the only role allowed to TRUNCATE the append-only audit log, and only on a
// database marked non-production by database/roles.sql. The API's own role cannot seed. Set it up with database/roles.sql (see README).
require('dotenv').config({ quiet: true });
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const { assertSeedAllowed } = require('./seed-guard');

const prisma = new PrismaClient({ datasources: { db: { url: process.env.SEED_DATABASE_URL || process.env.DATABASE_URL } } });

// Deterministic PRNG so the seed is reproducible
let seed = 42;
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
const int = (min, max) => Math.floor(rand() * (max - min + 1)) + min;

const DEPARTMENTS = [
  { name: 'Emergency Medicine', icon: 'Siren', isEmergency: true, location: 'Ground Floor, Block A', phone: '+1 555 0100', description: 'Round-the-clock triage and stabilisation for urgent and life-threatening conditions.', keywords: 'unconscious,bleeding,accident,injury,trauma,collapse,burn,poison,overdose' },
  { name: 'Cardiology', icon: 'HeartPulse', location: '2nd Floor, Block B', phone: '+1 555 0101', description: 'Diagnosis and treatment of heart and blood-vessel conditions, from hypertension to heart failure.', keywords: 'chest pain,heart,palpitation,blood pressure,cardiac,shortness of breath' },
  { name: 'Neurology', icon: 'Brain', location: '3rd Floor, Block B', phone: '+1 555 0102', description: 'Care for disorders of the brain, spine and nervous system including stroke, epilepsy and migraine.', keywords: 'seizure,stroke,headache,migraine,numbness,paralysis,dizziness,faint' },
  { name: 'Orthopedics', icon: 'Bone', location: '1st Floor, Block C', phone: '+1 555 0103', description: 'Bones, joints, ligaments and muscles — fractures, sports injuries and joint replacement.', keywords: 'fracture,bone,joint,back pain,sprain,knee,shoulder,fall' },
  { name: 'Pediatrics', icon: 'Baby', location: '1st Floor, Block A', phone: '+1 555 0104', description: 'Comprehensive medical care for infants, children and adolescents.', keywords: 'child,baby,infant,kid,newborn' },
  { name: 'Pulmonology', icon: 'Wind', location: '2nd Floor, Block C', phone: '+1 555 0105', description: 'Respiratory care for asthma, COPD, pneumonia and sleep-related breathing disorders.', keywords: 'breathing,asthma,cough,wheezing,lung,breath' },
  { name: 'Gastroenterology', icon: 'Pill', location: '3rd Floor, Block C', phone: '+1 555 0106', description: 'Digestive system and liver care, including endoscopy services.', keywords: 'stomach,abdominal,vomiting,diarrhea,nausea,liver' },
  { name: 'Dermatology', icon: 'Sparkles', location: '4th Floor, Block A', phone: '+1 555 0107', description: 'Skin, hair and nail conditions, allergies and cosmetic dermatology.', keywords: 'rash,skin,itching,hives,swelling' },
  { name: 'General Medicine', icon: 'Stethoscope', location: 'Ground Floor, Block B', phone: '+1 555 0108', description: 'Primary care, preventive health checks and management of chronic illnesses.', keywords: 'fever,cold,flu,fatigue,weakness,infection' },
  { name: 'Obstetrics & Gynecology', icon: 'Flower2', location: '4th Floor, Block B', phone: '+1 555 0109', description: "Women's health, pregnancy care and childbirth.", keywords: 'pregnancy,pregnant,labor,pelvic' },
];

const DOCTORS = [
  ['Sarah Mitchell', 'FEMALE', 'Emergency Physician', ['Emergency Medicine', 'General Medicine'], 'MD, FACEP', 14, 120],
  ['James Okafor', 'MALE', 'Trauma & Emergency Care', ['Emergency Medicine'], 'MBBS, MD (Emergency Medicine)', 9, 110],
  ['Elena Rodriguez', 'FEMALE', 'Interventional Cardiologist', ['Cardiology'], 'MD, DM (Cardiology)', 18, 200],
  ['David Chen', 'MALE', 'Cardiologist', ['Cardiology', 'General Medicine'], 'MD, FACC', 11, 180],
  ['Priya Raman', 'FEMALE', 'Neurologist', ['Neurology'], 'MD, DM (Neurology)', 12, 190],
  ['Michael Brooks', 'MALE', 'Orthopedic Surgeon', ['Orthopedics'], 'MS (Ortho), FRCS', 16, 170],
  ['Aisha Bello', 'FEMALE', 'Pediatrician', ['Pediatrics'], 'MD (Pediatrics)', 8, 130],
  ['Thomas Weber', 'MALE', 'Pulmonologist', ['Pulmonology', 'General Medicine'], 'MD, FCCP', 13, 160],
  ['Grace Kim', 'FEMALE', 'Gastroenterologist', ['Gastroenterology'], 'MD, DM (Gastro)', 10, 175],
  ['Rahul Verma', 'MALE', 'Dermatologist', ['Dermatology'], 'MD (Dermatology)', 7, 140],
  ['Olivia Grant', 'FEMALE', 'Family Physician', ['General Medicine'], 'MD, ABFM', 6, 90],
  ['Samuel Adeyemi', 'MALE', 'Obstetrician & Gynecologist', ['Obstetrics & Gynecology'], 'MD, FACOG', 15, 185],
  ['Hannah Lee', 'FEMALE', 'Pediatric Neurologist', ['Pediatrics', 'Neurology'], 'MD, FAAP', 9, 165],
  ['Marco Rossi', 'MALE', 'Sports Medicine', ['Orthopedics', 'General Medicine'], 'MD, CAQSM', 8, 150],
];

const FIRST = ['Liam', 'Emma', 'Noah', 'Ava', 'Ethan', 'Mia', 'Lucas', 'Sophia', 'Mason', 'Isabella', 'Arjun', 'Fatima', 'Kenji', 'Chloe', 'Mateo', 'Zara', 'Daniel', 'Amara', 'Leo', 'Nora', 'Omar', 'Lily', 'Ravi', 'Grace', 'Ivan', 'Hana', 'Jonah', 'Maya'];
const LAST = ['Johnson', 'Patel', 'Garcia', 'Nguyen', 'Smith', 'Khan', 'Brown', 'Silva', 'Wilson', 'Tanaka', 'Martin', 'Osei', 'Anderson', 'Lopez', 'Clark', 'Haddad'];
const BLOOD = ['A_POS', 'A_NEG', 'B_POS', 'B_NEG', 'AB_POS', 'AB_NEG', 'O_POS', 'O_NEG'];
const REASONS = ['Routine check-up', 'Follow-up consultation', 'Persistent headache', 'Chest discomfort', 'Knee pain after running', 'Skin rash', 'Recurring cough', 'Blood pressure review', 'Stomach pain', 'Annual physical', 'Medication review', 'Back pain', 'Fatigue and low energy'];
const DIAGNOSES = [
  ['Essential hypertension', 'Lifestyle modification, low-sodium diet, start Amlodipine 5mg'],
  ['Acute bronchitis', 'Rest, fluids, bronchodilator as needed'],
  ['Migraine without aura', 'Trigger avoidance, Sumatriptan PRN'],
  ['Patellofemoral pain syndrome', 'Physiotherapy, quadriceps strengthening, NSAIDs for 7 days'],
  ['Contact dermatitis', 'Avoid irritant, topical hydrocortisone 1%'],
  ['Gastroesophageal reflux disease', 'Omeprazole 20mg, dietary changes'],
  ['Type 2 diabetes mellitus — controlled', 'Continue Metformin, HbA1c in 3 months'],
  ['Iron deficiency anemia', 'Oral iron supplements, dietary counselling'],
];
const MEDS = [
  ['Amlodipine', '5 mg', 'Once daily', 30], ['Paracetamol', '500 mg', 'Every 6 hours as needed', 5], ['Omeprazole', '20 mg', 'Once daily before breakfast', 28],
  ['Ibuprofen', '400 mg', 'Twice daily after meals', 7], ['Salbutamol inhaler', '2 puffs', 'As needed', 30], ['Metformin', '500 mg', 'Twice daily', 90],
  ['Hydrocortisone cream 1%', 'Thin layer', 'Twice daily', 10], ['Ferrous sulfate', '325 mg', 'Once daily', 60], ['Sumatriptan', '50 mg', 'At migraine onset', 10],
];
const ALLERGENS = [['Penicillin', 'DRUG', 'SEVERE', 'Hives, swelling'], ['Peanuts', 'FOOD', 'LIFE_THREATENING', 'Anaphylaxis'], ['Sulfa drugs', 'DRUG', 'MODERATE', 'Rash'], ['Shellfish', 'FOOD', 'SEVERE', 'Throat swelling'], ['Aspirin', 'DRUG', 'MILD', 'Stomach upset'], ['Lactose', 'FOOD', 'MILD', 'Bloating'], ['Pollen', 'ENVIRONMENTAL', 'MILD', 'Sneezing']];
const CONDITIONS = ['Asthma', 'Type 2 Diabetes', 'Hypertension', 'Hypothyroidism', 'Migraine', 'Osteoarthritis'];
const EMERGENCIES = [
  ['CRITICAL', 'Severe chest pain radiating to left arm, sweating'], ['HIGH', 'Sudden severe headache with numbness on one side'],
  ['MEDIUM', 'Fall from stairs, suspected wrist fracture'], ['HIGH', 'Difficulty breathing, asthma attack not responding to inhaler'],
  ['LOW', 'High fever for two days with body aches'], ['MEDIUM', 'Persistent vomiting and abdominal pain since morning'],
  ['CRITICAL', 'Unconscious after accident, bleeding from head'], ['LOW', 'Skin rash with itching spreading on arms'],
];

const day = (offset, h = 0, m = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(h, m, 0, 0); return d; };

async function wipe() {
  // Order matters because of FK constraints
  const tables = ['audit_chain_baseline', 'audit_logs', 'notifications', 'department_messages', 'referrals', 'doctor_reviews', 'complaints', 'medical_reports', 'prescription_items', 'prescriptions',
    'emergency_events', 'emergency_notifications', 'emergency_requests', 'allergies', 'patient_medical_records', 'appointments', 'doctor_availability',
    'doctor_departments', 'departments', 'patients', 'doctors', 'admins', 'users'];
  try {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`);
  } catch (e) {
    if (/append-only|permission denied/i.test(e.message || '')) {
      console.error('Seeding was refused by the database: the audit log is append-only. Seed as the seeder role on a non-production database:\n'
        + '  1) run database/roles.sql (-v env=development -v with_seeder=on …)   2) set SEED_DATABASE_URL to the medicore_seeder URL   3) npm run db:seed');
    }
    throw e;
  }
}

async function main() {
  await assertSeedAllowed(prisma); // exits before anything is deleted if seeding is not allowed
  console.log('Seeding database…');
  await wipe();

  const adminHash = await bcrypt.hash('Admin@123', 12);
  const doctorHash = await bcrypt.hash('Doctor@123', 12);
  const patientHash = await bcrypt.hash('Patient@123', 12);

  // Admin
  const adminUser = await prisma.user.create({
    data: { email: 'admin@medicore.com', passwordHash: adminHash, role: 'ADMIN', createdAt: day(-150), admin: { create: { fullName: 'Alex Morgan', phone: '+1 555 0001', designation: 'Hospital Administrator' } } },
  });

  // Departments
  const depts = {};
  for (const d of DEPARTMENTS) depts[d.name] = await prisma.department.create({ data: d });

  // Doctors
  const doctors = [];
  for (let i = 0; i < DOCTORS.length; i += 1) {
    const [name, gender, spec, deptNames, qual, exp, fee] = DOCTORS[i];
    const email = `${name.split(' ')[0].toLowerCase()}.${name.split(' ')[1].toLowerCase()}@medicore.com`;
    // Varied schedules: most work Mon–Fri, emergency doctors also cover weekends
    const days = deptNames.includes('Emergency Medicine') ? [0, 1, 2, 3, 4, 5, 6] : i % 3 === 0 ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
    const availability = days.flatMap((dow) => (i % 2 === 0
      ? [{ dayOfWeek: dow, startTime: '09:00', endTime: '13:00' }, { dayOfWeek: dow, startTime: '14:00', endTime: '18:00' }]
      : [{ dayOfWeek: dow, startTime: '08:00', endTime: '12:00' }, { dayOfWeek: dow, startTime: '13:00', endTime: '16:00' }]));
    const user = await prisma.user.create({
      data: {
        email, passwordHash: doctorHash, role: 'DOCTOR', createdAt: day(-140 + i),
        doctor: {
          create: {
            fullName: name, gender, specialization: spec, qualification: qual, experienceYears: exp, consultationFee: fee,
            licenseNumber: `MED-${String(10234 + i * 37)}`, phone: `+1 555 02${String(i).padStart(2, '0')}`,
            bio: `Dr. ${name} is a ${spec.toLowerCase()} with ${exp} years of experience, known for clear communication and evidence-based, patient-centred care.`,
            slotDurationMinutes: 30, isAvailableForEmergency: i !== 9,
            departments: { create: deptNames.map((dn, idx) => ({ departmentId: depts[dn].id, isPrimary: idx === 0 })) },
            availability: { create: availability },
          },
        },
      },
      include: { doctor: { include: { availability: true } } },
    });
    doctors.push({ ...user.doctor, deptIds: deptNames.map((dn) => depts[dn].id), userId: user.id });
  }
  // Department heads
  for (const [deptName, docIdx] of [['Emergency Medicine', 0], ['Cardiology', 2], ['Neurology', 4], ['Orthopedics', 5], ['Pediatrics', 6], ['Pulmonology', 7], ['Gastroenterology', 8], ['Dermatology', 9], ['General Medicine', 10], ['Obstetrics & Gynecology', 11]]) {
    await prisma.department.update({ where: { id: depts[deptName].id }, data: { headDoctorId: doctors[docIdx].id } });
  }

  // Patients (registration spread over the last 120 days for the trend chart)
  const patients = [];
  for (let i = 0; i < 32; i += 1) {
    const first = FIRST[i % FIRST.length]; const last = LAST[(i * 7) % LAST.length];
    const email = i === 0 ? 'patient@medicore.com' : `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`;
    const createdAt = day(-int(1, 120), int(8, 20), int(0, 59));
    const user = await prisma.user.create({
      data: {
        email, passwordHash: patientHash, role: 'PATIENT', createdAt, lastLoginAt: day(-int(0, 10)),
        patient: {
          create: {
            fullName: i === 0 ? 'John Carter' : `${first} ${last}`, createdAt,
            gender: pick(['MALE', 'FEMALE']), bloodGroup: pick(BLOOD), dateOfBirth: new Date(int(1950, 2015), int(0, 11), int(1, 28)),
            phone: `+1 555 3${String(100 + i)}`, address: `${int(10, 999)} ${pick(['Maple', 'Oak', 'Cedar', 'Pine', 'Elm'])} Street, Springfield`,
            heightCm: int(150, 190), weightKg: int(50, 95),
            emergencyContactName: `${pick(FIRST)} ${last}`, emergencyContactPhone: `+1 555 4${String(100 + i)}`,
          },
        },
      },
      include: { patient: true },
    });
    patients.push({ ...user.patient, userId: user.id });
  }

  // Allergies & medical history
  for (const p of patients) {
    const n = int(0, 2);
    const used = new Set();
    for (let k = 0; k < n; k += 1) {
      const [allergen, type, severity, reaction] = pick(ALLERGENS);
      if (used.has(allergen)) continue; used.add(allergen);
      await prisma.allergy.create({ data: { patientId: p.id, allergen, type, severity, reaction } });
    }
    if (chance(0.6)) {
      await prisma.patientMedicalRecord.create({
        data: { patientId: p.id, createdByUserId: p.userId, recordType: 'CONDITION', title: pick(CONDITIONS), description: 'Self-reported existing condition', diagnosedOn: new Date(int(2010, 2024), int(0, 11), 1) },
      });
    }
    if (chance(0.3)) {
      await prisma.patientMedicalRecord.create({
        data: { patientId: p.id, createdByUserId: p.userId, recordType: 'SURGERY', title: pick(['Appendectomy', 'Tonsillectomy', 'Knee arthroscopy', 'C-section']), status: 'RESOLVED', diagnosedOn: new Date(int(2005, 2023), int(0, 11), 1) },
      });
    }
  }

  // Appointments: past 75 days (mostly completed) and next 14 days (pending/confirmed)
  const patientSlots = new Set();
  let apptCount = 0; let rxCount = 0; let reviewCount = 0;
  for (const doc of doctors) {
    for (let offset = -75; offset <= 14; offset += 1) {
      const date = day(offset);
      const blocks = doc.availability.filter((a) => a.dayOfWeek === date.getDay());
      if (!blocks.length) continue;
      const perDay = offset < 0 ? int(0, 3) : int(0, 2);
      const usedTimes = new Set();
      for (let k = 0; k < perDay; k += 1) {
        const block = pick(blocks);
        const [sh] = block.startTime.split(':').map(Number);
        const [eh] = block.endTime.split(':').map(Number);
        const startAt = day(offset, int(sh, eh - 1), pick([0, 30]));
        if (usedTimes.has(startAt.getTime())) continue;
        if (offset === 0 && startAt < new Date() && chance(0.5)) continue;
        const patient = pick(patients);
        const pKey = `${patient.id}-${startAt.getTime()}`;
        if (patientSlots.has(pKey)) continue;
        usedTimes.add(startAt.getTime()); patientSlots.add(pKey);

        const isPast = startAt < new Date();
        const r = rand();
        const status = isPast
          ? (r < 0.72 ? 'COMPLETED' : r < 0.84 ? 'CANCELLED' : r < 0.92 ? 'NO_SHOW' : 'REJECTED')
          : (r < 0.45 ? 'PENDING' : r < 0.9 ? 'CONFIRMED' : 'CANCELLED');
        const [diagnosis, treatment] = pick(DIAGNOSES);
        const appt = await prisma.appointment.create({
          data: {
            patientId: patient.id, doctorId: doc.id, departmentId: pick(doc.deptIds), startAt, endAt: new Date(startAt.getTime() + 30 * 60000),
            status, reason: pick(REASONS), type: chance(0.25) ? 'FOLLOW_UP' : 'CONSULTATION',
            approvedByAdmin: status === 'CONFIRMED' && chance(0.3),
            diagnosis: status === 'COMPLETED' ? diagnosis : null, treatment: status === 'COMPLETED' ? treatment : null,
            completedAt: status === 'COMPLETED' ? new Date(startAt.getTime() + 25 * 60000) : null,
            cancelledAt: status === 'CANCELLED' ? new Date(startAt.getTime() - 86400000) : null,
            statusReason: status === 'CANCELLED' ? 'Schedule conflict' : status === 'REJECTED' ? 'Doctor unavailable — please rebook' : null,
            createdAt: new Date(startAt.getTime() - int(1, 10) * 86400000),
          },
        });
        apptCount += 1;

        if (status === 'COMPLETED') {
          if (chance(0.55)) {
            const items = Array.from({ length: int(1, 3) }, () => pick(MEDS));
            const uniqueItems = [...new Map(items.map((m) => [m[0], m])).values()];
            await prisma.prescription.create({
              data: {
                prescriptionNumber: `RX-SEED-${String(rxCount + 1).padStart(5, '0')}`, appointmentId: appt.id, doctorId: doc.id, patientId: patient.id,
                diagnosis, advice: 'Stay hydrated, rest well and return if symptoms worsen.', followUpDate: chance(0.5) ? day(offset + 30) : null,
                createdAt: appt.completedAt,
                items: { create: uniqueItems.map(([medicineName, dosage, frequency, durationDays]) => ({ medicineName, dosage, frequency, durationDays, instructions: 'After food' })) },
              },
            });
            rxCount += 1;
          }
          if (chance(0.6)) {
            const rating = pick([5, 5, 5, 4, 4, 4, 3, 5, 4, 2]);
            await prisma.doctorReview.create({
              data: {
                doctorId: doc.id, patientId: patient.id, appointmentId: appt.id, rating, createdAt: new Date(startAt.getTime() + 86400000),
                comment: rating >= 4 ? pick(['Very attentive and explained everything clearly.', 'Excellent care, highly recommend.', 'Friendly and professional.', 'Short waiting time and great advice.']) : pick(['Had to wait quite long.', 'Consultation felt rushed.']),
              },
            });
            reviewCount += 1;
          }
          if (chance(0.25)) {
            await prisma.patientMedicalRecord.create({
              data: { patientId: patient.id, appointmentId: appt.id, createdByUserId: doc.userId, recordType: 'DIAGNOSIS', title: diagnosis, description: treatment, diagnosedOn: startAt },
            });
          }
        }
      }
    }
  }

  // Emergencies: historic resolved cases plus a couple of active ones
  const emergencyDept = depts['Emergency Medicine'];
  for (let i = 0; i < 18; i += 1) {
    const [priority, symptoms] = pick(EMERGENCIES);
    const patient = patients[(i * 5 + 3) % patients.length];
    const createdAt = day(-int(1, 70), int(0, 23), int(0, 59));
    const deptName = DEPARTMENTS.find((d) => d.keywords.split(',').some((k) => symptoms.toLowerCase().includes(k)))?.name || 'Emergency Medicine';
    const dept = depts[deptName];
    const candidates = doctors.filter((d) => d.deptIds.includes(dept.id) || d.deptIds.includes(emergencyDept.id));
    const assigned = pick(candidates);
    const acceptedAt = new Date(createdAt.getTime() + int(2, 25) * 60000);
    const resolvedAt = new Date(acceptedAt.getTime() + int(30, 240) * 60000);
    const cancelled = chance(0.1);
    await prisma.emergencyRequest.create({
      data: {
        patientId: patient.id, departmentId: dept.id, priority, symptoms, status: cancelled ? 'CANCELLED' : 'RESOLVED',
        assignedDoctorId: cancelled ? null : assigned.id, contactPhone: patient.phone, locationConsent: chance(0.6),
        notifiedAt: new Date(createdAt.getTime() + 5000), acceptedAt: cancelled ? null : acceptedAt, resolvedAt: cancelled ? createdAt : resolvedAt,
        escalationLevel: chance(0.2) ? 1 : 0, resolutionNotes: cancelled ? null : 'Patient stabilised and treated. Follow-up advised.',
        createdAt,
        notifications: { create: candidates.slice(0, 4).map((d) => ({ doctorId: d.id, status: d.id === assigned.id && !cancelled ? 'ACCEPTED' : 'EXPIRED', sentAt: createdAt, respondedAt: d.id === assigned.id ? acceptedAt : null })) },
        events: {
          create: [
            { eventType: 'CREATED', message: `Emergency submitted by patient with ${priority} priority`, actorUserId: patient.userId, createdAt },
            { eventType: 'DEPARTMENT_IDENTIFIED', message: `${dept.name} (Matched from symptoms)`, createdAt: new Date(createdAt.getTime() + 2000) },
            { eventType: 'DOCTORS_NOTIFIED', message: `${Math.min(4, candidates.length)} available doctor(s) alerted`, createdAt: new Date(createdAt.getTime() + 5000) },
            ...(cancelled ? [{ eventType: 'CANCELLED', message: 'Cancelled by patient', createdAt: new Date(createdAt.getTime() + 60000) }] : [
              { eventType: 'ACCEPTED', message: `Accepted by Dr. ${assigned.fullName}`, actorUserId: assigned.userId, createdAt: acceptedAt },
              { eventType: 'RESOLVED', message: `Resolved by Dr. ${assigned.fullName}`, actorUserId: assigned.userId, createdAt: resolvedAt },
            ]),
          ],
        },
      },
    });
  }
  // One active emergency awaiting a doctor (demonstrates the live workflow)
  const activePatient = patients[5];
  const card = depts.Cardiology;
  const cardDocs = doctors.filter((d) => d.deptIds.includes(card.id));
  await prisma.emergencyRequest.create({
    data: {
      patientId: activePatient.id, departmentId: card.id, priority: 'HIGH', status: 'NOTIFIED', symptoms: 'Chest pain and palpitations for the last 30 minutes',
      contactPhone: activePatient.phone, locationConsent: true, latitude: 40.7128, longitude: -74.006, address: '12 Maple Street, Springfield',
      notifiedAt: day(0, new Date().getHours(), 0), createdAt: new Date(Date.now() - 12 * 60000),
      notifications: { create: cardDocs.map((d) => ({ doctorId: d.id, status: 'SENT' })) },
      events: { create: [
        { eventType: 'CREATED', message: 'Emergency submitted by patient with HIGH priority', actorUserId: activePatient.userId },
        { eventType: 'DEPARTMENT_IDENTIFIED', message: 'Cardiology (Matched from symptoms)' },
        { eventType: 'DOCTORS_NOTIFIED', message: `${cardDocs.length} available doctor(s) alerted` },
      ] },
    },
  });
  for (const d of cardDocs) {
    await prisma.notification.create({ data: { userId: d.userId, type: 'EMERGENCY', title: 'HIGH emergency alert', message: 'Cardiology: Chest pain and palpitations for the last 30 minutes', link: '/doctor/emergencies' } });
  }

  // Referrals & department messages
  await prisma.referral.create({ data: { patientId: patients[2].id, fromDoctorId: doctors[10].id, toDoctorId: doctors[3].id, departmentId: card.id, reason: 'Abnormal ECG during routine check-up — please evaluate', status: 'PENDING' } });
  await prisma.departmentMessage.create({ data: { senderDoctorId: doctors[0].id, fromDepartmentId: emergencyDept.id, toDepartmentId: card.id, subject: 'Cardiology on-call cover this weekend', body: 'Could Cardiology confirm the on-call consultant for Saturday night? We expect higher ED volume.' } });

  // Complaints
  const complaints = [
    [patients[1], 'APPOINTMENT', 'Long waiting time', 'I waited more than 45 minutes past my appointment time at the cardiology clinic.', 'OPEN'],
    [patients[4], 'BILLING', 'Incorrect invoice amount', 'My invoice includes a lab test that was not performed during my visit.', 'IN_PROGRESS'],
    [patients[7], 'FACILITY', 'Parking availability', 'Parking near Block B is always full in the mornings.', 'RESOLVED'],
  ];
  for (const [p, category, subject, description, status] of complaints) {
    await prisma.complaint.create({
      data: {
        complainantUserId: p.userId, category, subject, description, status,
        ...(status !== 'OPEN' ? { response: 'Thank you for the feedback — we are looking into this and will update you.', respondedByUserId: adminUser.id, respondedAt: day(-1) } : {}),
      },
    });
  }
  await prisma.complaint.create({ data: { complainantUserId: doctors[5].userId, category: 'TECHNICAL', subject: 'Imaging viewer is slow', description: 'The X-ray viewer in consultation room 3 takes over a minute to load studies.' } });

  // Welcome notifications
  await prisma.notification.createMany({
    data: [
      { userId: patients[0].userId, type: 'SYSTEM', title: 'Welcome to MediCore', message: 'Complete your medical profile so doctors have the information they need.', link: '/patient/medical-profile' },
      { userId: adminUser.id, type: 'SYSTEM', title: 'System ready', message: 'Seed data loaded successfully.' },
    ],
  });

  // Audit trail sample for the activity feed
  const actions = ['LOGIN', 'APPOINTMENT_BOOKED', 'PATIENT_RECORD_VIEWED', 'PRESCRIPTION_CREATED', 'REPORT_UPLOADED', 'APPOINTMENT_CONFIRMED'];
  for (let i = 0; i < 60; i += 1) {
    const isDoc = chance(0.5);
    const actor = isDoc ? pick(doctors) : pick(patients);
    await prisma.auditLog.create({
      data: { userId: actor.userId, userRole: isDoc ? 'DOCTOR' : 'PATIENT', action: isDoc ? pick(['LOGIN', 'PATIENT_RECORD_VIEWED', 'PRESCRIPTION_CREATED', 'APPOINTMENT_CONFIRMED']) : pick(actions.slice(0, 2).concat('REPORT_UPLOADED')), ipAddress: '127.0.0.1', userAgent: 'seed', createdAt: new Date(Math.min(Date.now(), day(-int(0, 6), int(7, 21), int(0, 59)).getTime())) },
    });
  }

  console.log(`✔ Seed complete: ${DEPARTMENTS.length} departments, ${doctors.length} doctors, ${patients.length} patients, ${apptCount} appointments, ${rxCount} prescriptions, ${reviewCount} reviews`);
  console.log('\nLogin credentials:');
  console.log('  Admin   → admin@medicore.com / Admin@123');
  console.log('  Doctor  → sarah.mitchell@medicore.com / Doctor@123  (any doctor email, same password)');
  console.log('  Doctor  → david.chen@medicore.com / Doctor@123      (Cardiology — has a live emergency alert)');
  console.log('  Patient → patient@medicore.com / Patient@123');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
