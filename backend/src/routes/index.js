const router = require('express').Router();

router.get('/health', (req, res) => { const time = new Date().toISOString(); res.json({ success: true, data: { status: 'ok', time }, status: 'ok', time }); });
router.use('/auth', require('./auth.routes'));
router.use('/public', require('./public.routes'));
router.use('/admin', require('./admin.routes'));
router.use('/doctor', require('./doctor.routes'));
router.use('/patient', require('./patient.routes'));
router.use('/', require('./shared.routes'));

module.exports = router;
