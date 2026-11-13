const router = require('express').Router();
const h = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { idParam, listQuery, pageQuery, complaint } = require('../validators/schemas');
const notifications = require('../controllers/notification.controller');
const complaints = require('../controllers/complaint.controller');
const files = require('../controllers/file.controller');

router.use(authenticate);

router.get('/notifications', validate({ query: listQuery }), h(notifications.list));
router.patch('/notifications/read-all', h(notifications.markAllRead));
router.patch('/notifications/:id/read', validate({ params: idParam }), h(notifications.markRead));
router.delete('/notifications/:id', validate({ params: idParam }), h(notifications.remove));

router.get('/complaints', authorize('DOCTOR', 'PATIENT'), validate({ query: pageQuery }), h(complaints.listMine));
router.post('/complaints', authorize('DOCTOR', 'PATIENT'), validate({ body: complaint }), h(complaints.create));

router.get('/files/reports/:id', authorize('ADMIN', 'DOCTOR', 'PATIENT'), validate({ params: idParam }), h(files.downloadReport));
router.get('/files/prescriptions/:id/pdf', authorize('ADMIN', 'DOCTOR', 'PATIENT'), validate({ params: idParam }), h(files.prescriptionPdf));

module.exports = router;
