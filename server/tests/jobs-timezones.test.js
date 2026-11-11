import { describe, it, expect } from 'vitest';
import { nextBusinessTime, isWithinBusinessHours, startOfUserDay, endOfUserDay, localParts, callWindowMemo, addLocalDays } from '../src/lib/timezones.js';

/** The previous implementation: step forward 15 minutes until inside the window (reference only). */
function stepped(tz, date, start, end, skipWeekends) {
  let d = new Date(date);
  for (let i = 0; i < 8 * 24 * 4; i++) {
    if (isWithinBusinessHours(tz, start, end, d, skipWeekends)) return d;
    d = new Date(d.getTime() + 15 * 60000);
    d.setSeconds(0, 0);
  }
  return d;
}

const ZONES = ['America/Chicago', 'America/New_York', 'America/Los_Angeles', 'America/Phoenix', 'Pacific/Honolulu', 'America/Anchorage'];

describe('time zone helpers', () => {
  it('nextBusinessTime agrees with stepping, without the loop', () => {
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 300; i++) {
      const tz = ZONES[i % ZONES.length];
      const date = new Date(Date.UTC(2026, 0, 1) + rand() * 365 * 86400000);
      const [start, end] = [[9, 17], [8, 12], [0, 24], [13, 14]][i % 4];
      const skip = i % 3 !== 0;
      const fast = nextBusinessTime(tz, date, start, end, skip);
      const ref = stepped(tz, date, start, end, skip);
      expect(isWithinBusinessHours(tz, start, end, fast, skip)).toBe(true);
      expect(fast.getTime()).toBeGreaterThanOrEqual(date.getTime());
      // The reference lands on a 15-minute step at or after the window opens.
      expect(ref.getTime() - fast.getTime()).toBeGreaterThanOrEqual(0);
      expect(ref.getTime() - fast.getTime()).toBeLessThan(15 * 60000);
    }
  });

  it('is fast enough for bulk enrollment and list endpoints', () => {
    const t0 = performance.now();
    const fri = new Date('2026-11-13T23:05:00Z');
    for (let i = 0; i < 10000; i++) nextBusinessTime('America/Chicago', new Date(fri.getTime() + i * 1000), 9, 17, true);
    expect(performance.now() - t0).toBeLessThan(1500);
    const memo = callWindowMemo(new Date());
    expect(memo('America/Chicago')).toBe(memo('America/Chicago'));
  });

  it('local day boundaries handle 23- and 25-hour days', () => {
    const spring = new Date('2026-03-08T18:00:00Z');
    expect(endOfUserDay('America/Chicago', spring).getTime() + 1 - startOfUserDay('America/Chicago', spring).getTime()).toBe(23 * 3600000);
    const fall = new Date('2026-11-01T18:00:00Z');
    expect(endOfUserDay('America/Chicago', fall).getTime() + 1 - startOfUserDay('America/Chicago', fall).getTime()).toBe(25 * 3600000);
    expect(localParts('America/Chicago', startOfUserDay('America/Chicago', spring))).toMatchObject({ hour: 0, minute: 0, date: '2026-03-08' });
    expect(addLocalDays('America/Chicago', new Date('2026-03-07T15:00:00Z'), 1).toISOString()).toBe('2026-03-08T14:00:00.000Z');
    expect(localParts('Not/A_Zone', new Date('2026-01-01T12:00:00Z')).hour).toBe(12); // unknown zones fall back to UTC
  });
});
