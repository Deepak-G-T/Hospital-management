const http = require('http');
const env = require('./config/env');
const app = require('./app');
const prisma = require('./config/prisma');
const { initSocket } = require('./socket');
const escalationWorker = require('./workers/escalation.worker');

const server = http.createServer(app);
initSocket(server);

async function start() {
  await prisma.$connect();
  server.listen(env.port, () => {
    console.log(`🏥 Smart Hospital API running on http://localhost:${env.port} (${env.nodeEnv})`);
    escalationWorker.start(); // only when enabled by configuration (off by default in production)
  });
}

async function shutdown(signal) {
  console.log(`${signal} received, shutting down…`);
  server.close();
  await escalationWorker.stop();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
