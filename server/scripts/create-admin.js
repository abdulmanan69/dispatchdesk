#!/usr/bin/env node
// Create or promote a super admin.
// Usage: node scripts/create-admin.js <email> <password> [name]
// In Docker: docker compose exec app node scripts/create-admin.js admin@example.com 'StrongPass1' 'Jane Admin'
import bcrypt from 'bcryptjs';
import { prisma } from '../src/db.js';
import { bootstrap } from '../src/bootstrap.js';

const [email, password, ...nameParts] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: node scripts/create-admin.js <email> <password> [name]');
  process.exit(1);
}
if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
  console.error('Password must be at least 8 characters and include a letter and a number.');
  process.exit(1);
}

await bootstrap({ quiet: true });
const role = await prisma.role.findUnique({ where: { key: 'super_admin' } });
const normalized = email.trim().toLowerCase();
const passwordHash = await bcrypt.hash(password, 12);
const existing = await prisma.user.findUnique({ where: { email: normalized } });
if (existing) {
  await prisma.user.update({ where: { id: existing.id }, data: { roleId: role.id, passwordHash, status: 'active' } });
  console.log(`Updated ${normalized}: role super_admin, password reset.`);
} else {
  await prisma.user.create({ data: { email: normalized, name: nameParts.join(' ') || 'Administrator', passwordHash, roleId: role.id, emailVerifiedAt: new Date() } });
  console.log(`Created super admin ${normalized}.`);
}
await prisma.auditLog.create({ data: { action: 'admin.cli_create_admin', entityType: 'user', details: JSON.stringify({ email: normalized }) } });
await prisma.$disconnect();
