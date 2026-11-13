const router = require('express').Router();
const h = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { authLimiter } = require('../middleware/rateLimit');
const { idParam, listQuery, contact } = require('../validators/schemas');
const c = require('../controllers/public.controller');

router.get('/stats', h(c.stats));
router.get('/departments', validate({ query: listQuery }), h(c.listDepartments));
router.get('/departments/:id', validate({ params: idParam }), h(c.getDepartment));
router.get('/doctors', validate({ query: listQuery }), h(c.listDoctors));
router.get('/doctors/:id', validate({ params: idParam }), h(c.getDoctor));
router.get('/doctors/:id/slots', validate({ params: idParam }), h(c.getDoctorSlots));
router.post('/contact', authLimiter, validate({ body: contact }), h(c.contact));

module.exports = router;
