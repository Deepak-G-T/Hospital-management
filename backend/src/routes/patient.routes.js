const router = require('express').Router();
const h = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadReport, verifyFileSignature } = require('../middleware/upload');
const { idParam, listQuery, pageQuery, patient: s, report } = require('../validators/schemas');
const c = require('../controllers/patient.controller');

router.use(authenticate, authorize('PATIENT'));

router.get('/dashboard', h(c.dashboard));
router.get('/profile', h(c.getProfile));
router.put('/profile', validate({ body: s.profile }), h(c.updateProfile));

router.get('/appointments', validate({ query: listQuery }), h(c.listAppointments));
router.post('/appointments', validate({ body: s.book }), h(c.bookAppointment));
router.patch('/appointments/:id/cancel', validate({ params: idParam, body: s.cancel }), h(c.cancelAppointment));
router.patch('/appointments/:id/reschedule', validate({ params: idParam, body: s.reschedule }), h(c.rescheduleAppointment));

router.get('/medical-records', h(c.listRecords));
router.post('/medical-records', validate({ body: s.record }), h(c.createRecord));
router.put('/medical-records/:id', validate({ params: idParam, body: s.record }), h(c.updateRecord));
router.delete('/medical-records/:id', validate({ params: idParam }), h(c.deleteRecord));
router.post('/medical-records/:id/restore', validate({ params: idParam }), h(c.restoreRecord));

router.get('/allergies', h(c.listAllergies));
router.post('/allergies', validate({ body: s.allergy }), h(c.createAllergy));
router.put('/allergies/:id', validate({ params: idParam, body: s.allergy }), h(c.updateAllergy));
router.delete('/allergies/:id', validate({ params: idParam }), h(c.deleteAllergy));
router.post('/allergies/:id/restore', validate({ params: idParam }), h(c.restoreAllergy));

router.get('/reports', validate({ query: pageQuery }), h(c.listReports));
router.post('/reports', uploadReport, verifyFileSignature, validate({ body: report }), h(c.uploadReport));
router.delete('/reports/:id', validate({ params: idParam }), h(c.deleteReport));
router.post('/reports/:id/restore', validate({ params: idParam }), h(c.restoreReport));

router.get('/emergencies', h(c.listEmergencies));
router.post('/emergencies', validate({ body: s.emergency }), h(c.createEmergency));
router.post('/emergencies/:id/cancel', validate({ params: idParam }), h(c.cancelEmergency));

router.get('/prescriptions', validate({ query: pageQuery }), h(c.listPrescriptions));

router.get('/reviews', validate({ query: pageQuery }), h(c.listReviews));
router.post('/reviews', validate({ body: s.review }), h(c.createReview));

module.exports = router;
