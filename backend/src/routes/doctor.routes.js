const router = require('express').Router();
const h = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadReport, verifyFileSignature } = require('../middleware/upload');
const { idParam, listQuery, pageQuery, doctor: s, report } = require('../validators/schemas');
const c = require('../controllers/doctor.controller');

router.use(authenticate, authorize('DOCTOR'));

router.get('/dashboard', validate({ query: listQuery }), h(c.dashboard));
router.get('/profile', h(c.getProfile));
router.put('/profile', validate({ body: s.profile }), h(c.updateProfile));
router.get('/availability', h(c.getAvailability));
router.put('/availability', validate({ body: s.availability }), h(c.setAvailability));

router.get('/appointments', validate({ query: listQuery }), h(c.listAppointments));
router.patch('/appointments/:id/status', validate({ params: idParam, body: s.appointmentStatus }), h(c.updateAppointmentStatus));
router.patch('/appointments/:id/consultation', validate({ params: idParam, body: s.consultation }), h(c.saveConsultation));

router.get('/patients', validate({ query: listQuery }), h(c.listPatients));
router.get('/patients/:id', validate({ params: idParam }), h(c.getPatient));
router.post('/patients/:id/records', validate({ params: idParam, body: s.record }), h(c.addPatientRecord));
router.post('/patients/:id/reports', validate({ params: idParam }), uploadReport, verifyFileSignature, validate({ body: report }), h(c.uploadPatientReport));

router.get('/prescriptions', validate({ query: listQuery }), h(c.listPrescriptions));
router.post('/prescriptions', validate({ body: s.prescription }), h(c.createPrescription));

router.get('/emergencies', validate({ query: listQuery }), h(c.listEmergencies));
router.post('/emergencies/:id/seen', validate({ params: idParam }), h(c.markEmergencySeen));
router.post('/emergencies/:id/accept', validate({ params: idParam, body: s.emergencyAccept }), h(c.acceptEmergency));
router.post('/emergencies/:id/acknowledge', validate({ params: idParam }), h(c.acknowledgeEmergency));
router.post('/emergencies/:id/escalate', validate({ params: idParam, body: s.emergencyEscalate }), h(c.escalateEmergency));
router.post('/emergencies/:id/resolve', validate({ params: idParam }), h(c.resolveEmergency));

router.get('/colleagues', h(c.colleagues));
router.get('/referrals', h(c.listReferrals));
router.post('/referrals', validate({ body: s.referral }), h(c.createReferral));
router.patch('/referrals/:id', validate({ params: idParam, body: s.referralStatus }), h(c.updateReferral));

router.get('/messages', h(c.listMessages));
router.post('/messages', validate({ body: s.message }), h(c.sendMessage));

router.get('/reviews', validate({ query: pageQuery }), h(c.listReviews));

module.exports = router;
