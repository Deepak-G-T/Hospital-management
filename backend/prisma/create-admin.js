/* eslint-disable no-console */
// Creates an administrator account without touching any other data.
// Use this for production instead of the seed (the seed WIPES the database).
//
//   ADMIN_EMAIL=you@hospital.org ADMIN_NAME="Your Name" ADMIN_PASSWORD='S3cure-pass' npm run create-admin
//
// If ADMIN_PASSWORD is not set and the terminal is interactive, you are prompted for it (input hidden).
require('dotenv').config({ quiet: true });
const readline = require('readline');
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

async function main() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const fullName = String(process.env.ADMIN_NAME || '').trim();
  let password = process.env.ADMIN_PASSWORD;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Set ADMIN_EMAIL to a valid email address');
  if (fullName.length < 2) throw new Error('Set ADMIN_NAME (at least 2 characters)');
  if (!password) {
    if (!process.stdin.isTTY) throw new Error('Set ADMIN_PASSWORD (no interactive terminal to prompt in)');
    password = await promptHidden('Password for the new admin: ');
  }
  // Same rule the API enforces for every account
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error('Password must be at least 8 characters and contain a letter and a number');
  }

  const prisma = new PrismaClient();
  try {
    if (await prisma.user.findUnique({ where: { email } })) throw new Error(`An account with ${email} already exists — nothing changed`);
    const user = await prisma.user.create({
      data: {
        email, role: 'ADMIN', passwordHash: await bcrypt.hash(password, 12),
        admin: { create: { fullName, designation: process.env.ADMIN_DESIGNATION || 'Hospital Administrator' } },
      },
    });
    await prisma.auditLog.create({ data: { userId: user.id, userRole: 'ADMIN', action: 'ADMIN_CREATED_CLI', entityType: 'User', entityId: user.id, details: { email } } });
    console.log(`✔ Admin created: ${email}. Log in at /login.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(`✘ ${e.message}`); process.exit(1); });
