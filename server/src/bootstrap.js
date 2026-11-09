import bcrypt from 'bcryptjs';
import { prisma } from './db.js';
import { config } from './config.js';
import { STAGES, ROLES, PERMISSIONS, ROLE_PERMISSIONS } from './lib/constants.js';
import { seedTraining } from './seedTraining.js';

/** Default plans. Created once; admins can edit prices/limits afterwards (never overwritten). -1 = unlimited. */
export const DEFAULT_PLANS = [
  { key: 'free', name: 'Free', description: 'Carrier discovery, CRM, prospecting and pipeline. Free forever.', priceCents: 0, interval: 'month', maxCarriers: 1000, dailyEmailLimit: 20, monthlyAiMessages: 30, maxSequences: 1, maxAutomations: 1, maxDiscoveryPerDay: 100, monthlyLeadGenLimit: 50, maxLeadGenerators: 1, leadGenAutoRun: false, sortOrder: 0 },
  { key: 'pro', name: 'Pro', description: 'Higher limits, advanced AI dispatcher, automations and reporting.', priceCents: 999, interval: 'month', maxCarriers: 25000, dailyEmailLimit: 300, monthlyAiMessages: 1500, maxSequences: 25, maxAutomations: 25, maxDiscoveryPerDay: 2000, monthlyLeadGenLimit: 2000, maxLeadGenerators: 10, leadGenAutoRun: true, advancedReports: true, sortOrder: 1 },
  { key: 'annual', name: 'Annual', description: 'Everything in Pro billed yearly (20% off) plus the dispatch training entitlement.', priceCents: 9590, interval: 'year', maxCarriers: 25000, dailyEmailLimit: 300, monthlyAiMessages: 1500, maxSequences: 25, maxAutomations: 25, maxDiscoveryPerDay: 2000, monthlyLeadGenLimit: 2000, maxLeadGenerators: 10, leadGenAutoRun: true, advancedReports: true, trainingIncluded: true, sortOrder: 2 },
  { key: 'teams', name: 'Teams', description: 'Pro features for every member, team board, leaderboard and permissions.', priceCents: 799, interval: 'month', perSeat: true, minSeats: 2, trialDays: 14, maxCarriers: 50000, dailyEmailLimit: 500, monthlyAiMessages: 3000, maxSequences: 50, maxAutomations: 50, maxDiscoveryPerDay: 5000, monthlyLeadGenLimit: 5000, maxLeadGenerators: 25, leadGenAutoRun: true, advancedReports: true, teamFeatures: true, trainingIncluded: true, sortOrder: 3 },
];

export async function bootstrap({ quiet = false } = {}) {
  const log = (...a) => !quiet && console.log('[bootstrap]', ...a);

  for (const [key, description] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { key }, create: { key, description }, update: { description } });
  }
  const perms = await prisma.permission.findMany();
  const permId = Object.fromEntries(perms.map((p) => [p.key, p.id]));
  for (const role of ROLES) {
    const row = await prisma.role.upsert({ where: { key: role.key }, create: role, update: { name: role.name, description: role.description, rank: role.rank } });
    const wanted = ROLE_PERMISSIONS[role.key].map((k) => permId[k]);
    await prisma.rolePermission.deleteMany({ where: { roleId: row.id, permissionId: { notIn: wanted } } });
    for (const pid of wanted) {
      await prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: row.id, permissionId: pid } }, create: { roleId: row.id, permissionId: pid }, update: {} });
    }
  }

  for (const [i, s] of STAGES.entries()) {
    await prisma.pipelineStage.upsert({ where: { key: s.key }, create: { ...s, sortOrder: i }, update: { name: s.name, sortOrder: i, color: s.color } });
  }

  for (const plan of DEFAULT_PLANS) {
    const exists = await prisma.plan.findUnique({ where: { key: plan.key } });
    if (!exists) await prisma.plan.create({ data: plan });
  }

  // Initial super admin from environment (only created when missing; password never logged).
  if (config.admin.email && config.admin.password) {
    const email = config.admin.email.trim().toLowerCase();
    const superRole = await prisma.role.findUnique({ where: { key: 'super_admin' } });
    const existing = await prisma.user.findUnique({ where: { email } });
    if (!existing) {
      await prisma.user.create({
        data: { email, name: config.admin.name, passwordHash: await bcrypt.hash(config.admin.password, 12), roleId: superRole.id, emailVerifiedAt: new Date() },
      });
      log(`created super admin ${email}`);
    } else if (existing.roleId !== superRole.id && process.env.ADMIN_FORCE_ROLE === 'true') {
      await prisma.user.update({ where: { id: existing.id }, data: { roleId: superRole.id } });
      log(`promoted ${email} to super admin`);
    }
  } else {
    const anyAdmin = await prisma.user.count({ where: { role: { key: { in: ['super_admin', 'admin'] } } } });
    if (!anyAdmin) log('no admin account exists — set ADMIN_EMAIL and ADMIN_PASSWORD and restart, or run: node scripts/create-admin.js <email> <password>');
  }

  await seedTraining(log);
  // Remove expired sessions and tokens.
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  log('ready');
}
