import { describe, it, expect, afterEach } from 'vitest';
import { query, clearCensusCache } from '../src/services/carriers/fmcsaCensus.js';

const ok = (rows) => ({ ok: true, status: 200, json: async () => rows });
const where = (state) => ({ $where: `phy_state='${state}'` });

describe('FMCSA census response cache', () => {
  afterEach(() => clearCensusCache());

  it('answers identical cached queries once, shares requests in flight, and never caches uncached callers', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return ok([{ dot_number: '1' }]); };
    const [a, b] = await Promise.all([query(where('OH'), fetchImpl, { cacheMs: 60_000 }), query(where('OH'), fetchImpl, { cacheMs: 60_000 })]);
    expect(a).toEqual([{ dot_number: '1' }]);
    expect(b).toBe(a);
    expect(calls).toBe(1);
    await query(where('OH'), fetchImpl, { cacheMs: 60_000 });
    expect(calls).toBe(1);
    // Callers that need fresh data (lead-generator runs, saving to the CRM) always go upstream.
    await query(where('OH'), fetchImpl);
    expect(calls).toBe(2);
  });

  it('after a 429 fails fast for new queries but still serves cached answers', async () => {
    let calls = 0;
    const good = async () => { calls++; return ok([{ dot_number: '2' }]); };
    const limited = async () => { calls++; return { ok: false, status: 429, json: async () => ({}) }; };
    await query(where('TX'), good, { cacheMs: 60_000 });
    await expect(query(where('GA'), limited, { cacheMs: 60_000 })).rejects.toMatchObject({ status: 429 });
    const before = calls;
    await expect(query(where('FL'), good, { cacheMs: 60_000 })).rejects.toMatchObject({ status: 429 });
    await expect(query(where('FL'), good)).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(before);
    expect(await query(where('TX'), good, { cacheMs: 60_000 })).toEqual([{ dot_number: '2' }]);
    expect(calls).toBe(before);
  });

  it('does not cache failures', async () => {
    let calls = 0;
    const broken = async () => { calls++; return { ok: false, status: 500, json: async () => ({ message: 'boom' }) }; };
    await expect(query(where('NV'), broken, { cacheMs: 60_000 })).rejects.toMatchObject({ status: 502 });
    await expect(query(where('NV'), broken, { cacheMs: 60_000 })).rejects.toMatchObject({ status: 502 });
    expect(calls).toBe(2);
  });
});
