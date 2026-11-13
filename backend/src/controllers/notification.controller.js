const notifications = require('../services/notification.service');

exports.list = async (req, res) => {
  res.json({ success: true, data: await notifications.listForUser(req.user.id, req.query) });
};

exports.markRead = async (req, res) => {
  await notifications.markRead(req.user.id, req.params.id);
  res.json({ success: true });
};

exports.markAllRead = async (req, res) => {
  const { count } = await notifications.markAllRead(req.user.id);
  res.json({ success: true, data: { updated: count } });
};

exports.remove = async (req, res) => {
  await notifications.removeForUser(req.user.id, req.params.id);
  res.json({ success: true });
};
