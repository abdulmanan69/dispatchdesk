import { describe, it, expect } from 'vitest';
import { parseHours, hoursText, hoursInput, windowText, isStale, liveTag } from './fleetApi.js';

describe('fleet formatting helpers', () => {
  it('reads hours the way dispatchers type them', () => {
    expect(parseHours('6:30')).toBe(390);
    expect(parseHours('6.5')).toBe(390);
    expect(parseHours('11')).toBe(660);
    expect(parseHours('')).toBeNull();
    expect(Number.isNaN(parseHours('soon'))).toBe(true);
    expect(hoursText(390)).toBe('6 h 30 min');
    expect(hoursText(45)).toBe('45 min');
    expect(hoursInput(390)).toBe('6:30');
  });

  it('writes appointment windows in the stop time zone', () => {
    const w = { start: '2026-11-12T14:00:00Z', end: '2026-11-12T16:00:00Z', tz: 'America/Chicago' };
    expect(windowText(w)).toMatch(/Nov 12, 8:00.*10:00 AM CST/);
    expect(windowText({ start: '2026-11-12T14:00:00Z', end: '2026-11-12T14:00:00Z', tz: 'America/New_York' })).toMatch(/9:00 AM EST/);
    expect(windowText(null)).toBe('No appointment set');
  });

  it('works out stale GPS on the client', () => {
    const now = Date.now();
    expect(isStale({ lastAt: new Date(now - 20 * 60000) }, now)).toBe(true);
    expect(isStale({ lastAt: new Date(now - 60000) }, now)).toBe(false);
    const t = { live: { source: 'driver_link', lastAt: new Date(now - 20 * 60000), stale: false } };
    expect(liveTag(t, now).tone).toBe('stale');
  });
});
