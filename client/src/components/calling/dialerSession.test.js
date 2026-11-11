import { describe, it, expect, beforeEach } from 'vitest';
import { SESSION_MAX_AGE_MS, clearSession, loadSession, mergeResumed, saveSession, snapshotItem } from './dialerSession.js';

const item = (key, extra = {}) => ({
  key, enrollmentId: null, reason: 'Hot lead', dueAt: null, step: null, seq: { email: { body: 'large payload' } },
  carrier: { id: `c-${key}`, companyName: `Carrier ${key}`, phone: '5550100', state: 'TX', contacts: [{ name: 'x' }], stage: { key: 'lead', name: 'Lead', color: '#000', id: 1 } },
  ...extra,
});

describe('power dialer session storage', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('saves a small snapshot per user and restores it', () => {
    const session = { items: [item('a'), item('b'), item('c')], index: 1, results: [{ outcome: 'busy', carrier: 'Carrier a' }], skipped: 0 };
    saveSession('u1', { source: 'queue', includeUpcoming: false, session });
    const s = loadSession('u1');
    expect(s).toMatchObject({ source: 'queue', index: 1, skipped: 0, results: [{ outcome: 'busy' }] });
    expect(s.items).toHaveLength(3);
    expect(s.items[0].seq).toBeUndefined(); // bulky step data is not stored
    expect(s.items[0].carrier.contacts).toBeUndefined();
    expect(s.items[0].carrier.stage).toEqual({ key: 'lead', name: 'Lead', color: '#000' });
    expect(loadSession('someone-else')).toBeNull();
    clearSession('u1');
    expect(loadSession('u1')).toBeNull();
  });

  it('drops expired or malformed sessions', () => {
    saveSession('u1', { source: 'queue', session: { items: [item('a')], index: 0, results: [], skipped: 0 } });
    expect(loadSession('u1', Date.now() + SESSION_MAX_AGE_MS + 1)).toBeNull();
    window.sessionStorage.setItem('dd.dialer.session.u2', '{not json');
    expect(loadSession('u2')).toBeNull();
  });

  it('keeps worked and current items on resume and drops later ones that left the source', () => {
    const saved = { items: ['a', 'b', 'c', 'd'].map((k) => snapshotItem(item(k))), index: 1 };
    const fresh = [item('b', { reason: 'fresh b' }), item('d', { reason: 'fresh d' })];
    const out = mergeResumed(saved, fresh);
    expect(out.index).toBe(1);
    expect(out.items.map((i) => i.key)).toEqual(['a', 'b', 'd']);
    expect(out.items[1].reason).toBe('fresh b');
    // The current carrier stays even when it is no longer in the source.
    expect(mergeResumed({ ...saved, index: 2 }, fresh).items.map((i) => i.key)).toEqual(['a', 'b', 'c', 'd']);
    // Source could not be loaded: resume as saved.
    expect(mergeResumed(saved, null).items).toHaveLength(4);
  });
});
