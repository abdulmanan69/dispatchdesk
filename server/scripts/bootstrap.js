#!/usr/bin/env node
// Idempotent seed: roles, permissions, pipeline stages, default plans, training content, initial admin from env.
import { bootstrap } from '../src/bootstrap.js';
import { prisma } from '../src/db.js';

await bootstrap();
await prisma.$disconnect();
