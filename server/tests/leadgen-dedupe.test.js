import { describe, it, expect } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { dedupeKeys, IN_SLICE } from '../src/services/leadgen.js';
import { stageByKey } from '../src/services/pipeline.js';

/*
 * De-duplication for a run over many states: a census page holds 200 rows per state, so one page can carry thousands
 * of USDOT, MC, phone and email values. SQLite allows 999 bound parameters per statement; every lookup must slice.
 */
describe('lead generator de-duplication at scale', () => {
  it('checks 2,500 candidates (12+ states) without hitting the database parameter limit', async () => {
    const A = await registerUser();
    const user = await prisma.user.findUnique({ where: { id: A.user.id } });
    const stage = await stageByKey('lead');
    // Already in the CRM: one by USDOT (number 10), one by MC only (number 2400), one do-not-call phone, one suppressed email.
    await prisma.carrier.create({ data: { ownerId: user.id, stageId: stage.id, companyName: 'By DOT', dotNumber: '9000010' } });
    await prisma.carrier.create({ data: { ownerId: user.id, stageId: stage.id, companyName: 'By MC', mcNumber: '7002400' } });
    await prisma.carrier.create({ data: { ownerId: user.id, stageId: stage.id, companyName: 'DNC', phone: '7132001234', doNotCall: true } });
    await prisma.emailSuppression.create({ data: { ownerId: user.id, email: 'owner1999@gmail.com' } });
    const recs = Array.from({ length: 2500 }, (_, i) => ({
      dotNumber: String(9000000 + i), mcNumber: String(7000000 + i), phone: `713${2000000 + i}`, email: `owner${i}@gmail.com`,
    }));
    expect(recs.length).toBeGreaterThan(2 * IN_SLICE);
    const have = await dedupeKeys(user, recs);
    expect(have.dots.has('9000010')).toBe(true);
    expect(have.mcs.has('7002400')).toBe(true);
    expect(have.dncPhones.has('7132001234')).toBe(true);
    expect(have.suppressedEmails.has('owner1999@gmail.com')).toBe(true);
    expect(have.dots.size).toBe(1);
  });
});

describe('the limit this guards against', () => {
  it('one query with more values than SQLite allows fails (so slicing is needed)', async () => {
    const values = Array.from({ length: 2000 }, (_, i) => String(8000000 + i));
    await expect(prisma.carrier.findMany({ where: { dotNumber: { in: values }, mcNumber: { in: values } }, select: { id: true } })).rejects.toThrow(/parameter limit/i);
  });
});
