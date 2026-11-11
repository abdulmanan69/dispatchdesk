import { randomBytes } from 'node:crypto';

const SPACE = 36 ** 4;
let counter = Math.floor(Math.random() * SPACE);

/**
 * Collision-resistant row id in the same shape as Prisma's cuid(): 25 lower-case base-36 characters starting with "c"
 * (time, a per-process counter and 64 random bits). Used where rows are inserted with createMany and their ids are
 * needed for child rows (CSV import creates carriers, contacts and notes in the same batch).
 */
export function newId(now = Date.now()) {
  counter = (counter + 1) % SPACE;
  const time = now.toString(36).padStart(8, '0').slice(-8);
  const count = counter.toString(36).padStart(4, '0');
  const rand = BigInt(`0x${randomBytes(8).toString('hex')}`).toString(36).padStart(12, '0').slice(-12);
  return `c${time}${count}${rand}`;
}
