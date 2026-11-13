const router = require('express').Router();
const h = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { idParam, listQuery, admin: s, z } = require('../validators/schemas');
const admin = require('../controllers/admin.controller');
const doctors = require('../controllers/adminDoctors.controller');
const patients = require('../controllers/adminPatients.controller');
const departments = require('../controllers/departments.controller');

router.use(authenticate, authorize('ADMIN'));

router.get('/dashboard', validate({ query: listQuery }), h(admin.dashboard));

router.get('/doctors', validate({ query: listQuery }), h(doctors.list));
router.post('/doctors', validate({ body: s.createDoctor }), h(doctors.create));
router.get('/doctors/:id', validate({ params: idParam }), h(doctors.get));
router.put('/doctors/:id', validate({ params: idParam, body: s.updateDoctor }), h(doctors.update));
router.put('/doctors/:id/departments', validate({ params: idParam, body: s.assignDepartments }), h(doctors.assignDepartments));
router.delete('/doctors/:id', validate({ params: idParam }), h(doctors.remove));
router.post('/doctors/:id/restore', validate({ params: idParam }), h(doctors.restore));

router.get('/patients', validate({ query: listQuery }), h(patients.list));
router.post('/patients', validate({ body: s.createPatient }), h(patients.create));
router.get('/patients/:id', validate({ params: idParam }), h(patients.get));
router.put('/patients/:id', validate({ params: idParam, body: s.updatePatient }), h(patients.update));

router.get('/departments', h(departments.list));
router.post('/departments', validate({ body: s.department }), h(departments.create));
router.put('/departments/:id', validate({ params: idParam, body: s.department }), h(departments.update));
router.delete('/departments/:id', validate({ params: idParam }), h(departments.remove));
router.post('/departments/:id/restore', validate({ params: idParam }), h(departments.restore));
// Restoring a patient's deleted medical information needs a recorded reason (X-Access-Reason)
router.post('/restore/:kind/:id', validate({ params: z.object({ kind: z.enum(['records', 'allergies', 'reports']), id: z.string().uuid() }) }), h(admin.restoreClinical));

router.get('/appointments', validate({ query: listQuery }), h(admin.listAppointments));
router.patch('/appointments/:id/status', validate({ params: idParam, body: s.appointmentStatus }), h(admin.updateAppointmentStatus));

router.get('/escalation-config', h(admin.escalationConfig));
router.get('/emergencies', validate({ query: listQuery }), h(admin.listEmergencies));
router.get('/emergencies/:id', validate({ params: idParam }), h(admin.getEmergency));
router.patch('/emergencies/:id', validate({ params: idParam, body: s.emergencyUpdate }), h(admin.updateEmergency));
router.post('/emergencies/:id/acknowledge', validate({ params: idParam }), h(admin.acknowledgeEmergency));
router.post('/emergencies/:id/resolve', validate({ params: idParam, body: s.resolve }), h(admin.resolveEmergency));

router.get('/complaints', validate({ query: listQuery }), h(admin.listComplaints));
router.patch('/complaints/:id/respond', validate({ params: idParam, body: s.complaintRespond }), h(admin.respondComplaint));

router.get('/users', validate({ query: listQuery }), h(admin.listUsers));
router.patch('/users/:id/status', validate({ params: idParam, body: s.userStatus }), h(admin.setUserStatus));
router.post('/users/:id/reset-password', validate({ params: idParam, body: s.resetPassword }), h(admin.resetUserPassword));

router.get('/activity', validate({ query: listQuery }), h(admin.activity));
router.get('/audit-logs', validate({ query: listQuery }), h(admin.auditLogs));

router.get('/notifications/broadcasts', h(admin.listBroadcasts));
router.post('/notifications/broadcast', validate({ body: s.broadcast }), h(admin.broadcast));
router.delete('/notifications/broadcasts/:id', validate({ params: idParam }), h(admin.deleteBroadcast));

router.get('/reports/:type', validate({
  params: z.object({ type: z.enum(['appointments', 'doctors', 'departments', 'patients', 'emergencies', 'complaints']) }),
  query: listQuery,
}), h(admin.report));

module.exports = router;
