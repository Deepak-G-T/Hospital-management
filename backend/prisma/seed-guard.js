// Safety guard for prisma/seed.js, which TRUNCATEs every table before loading demo data.
// Seeding is refused when:
//   • NODE_ENV is "production" — unless BOTH `--force` is passed AND ALLOW_PRODUCTION_SEED=true
//   • the database already has users but not the demo admin (it looks like real data) — unless `--force` is passed
const DEMO_ADMIN_EMAIL = 'admin@medicore.com';

/** Returns null when seeding may go ahead, otherwise the reason it is refused. Pure, so it can be unit-tested. */
function seedBlockReason({ nodeEnv, force = false, allowProduction = false, userCount = 0, hasDemoAdmin = false }) {
  if (nodeEnv === 'production' && !(force && allowProduction)) {
    return 'NODE_ENV is "production". Seeding deletes ALL data. If you really mean it, pass --force AND set ALLOW_PRODUCTION_SEED=true.';
  }
  if (userCount > 0 && !hasDemoAdmin && !force) {
    return `the database already has ${userCount} user account(s) and none of them is the demo admin, so it looks like real data. Re-run with --force only if you are sure it can be deleted.`;
  }
  return null;
}

/** Checks the target database and exits the process before anything is deleted if seeding is not allowed */
async function assertSeedAllowed(prisma, { argv = process.argv, env = process.env } = {}) {
  const [userCount, demoAdmin] = await Promise.all([
    prisma.user.count(),
    prisma.user.findUnique({ where: { email: DEMO_ADMIN_EMAIL }, select: { id: true } }),
  ]);
  const reason = seedBlockReason({
    nodeEnv: env.NODE_ENV,
    force: argv.includes('--force'),
    allowProduction: env.ALLOW_PRODUCTION_SEED === 'true',
    userCount,
    hasDemoAdmin: Boolean(demoAdmin),
  });
  if (reason) {
    // eslint-disable-next-line no-console
    console.error(`✘ Seed refused: ${reason}\n  Nothing was changed.`);
    await prisma.$disconnect();
    process.exit(1);
  }
}

module.exports = { seedBlockReason, assertSeedAllowed, DEMO_ADMIN_EMAIL };
