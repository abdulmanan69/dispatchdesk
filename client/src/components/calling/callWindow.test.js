import { describe, it, expect } from 'vitest';
import { businessDayAt, callableAt, dateToZonedInput, nextMondayAt, tzOf, windowFor, zoneAbbr, zonedInputToDate, zonedParts, zonedToUtc } from './callWindow.js';

describe('carrier time helpers', () => {
  it('reads a typed time in the carrier zone, whatever the browser zone is', () => {
    expect(zonedInputToDate('2026-11-12T15:00', 'America/Chicago').toISOString()).toBe('2026-11-12T21:00:00.000Z');
    expect(zonedInputToDate('2026-07-01T09:30', 'America/New_York').toISOString()).toBe('2026-07-01T13:30:00.000Z');
    expect(zonedInputToDate('2026-07-01T09:30', 'America/Phoenix').toISOString()).toBe('2026-07-01T16:30:00.000Z');
    expect(zonedInputToDate('nope', 'America/Chicago')).toBeNull();
  });

  it('round-trips through datetime-local values and survives DST changes', () => {
    for (const tz of ['America/Chicago', 'America/Los_Angeles', 'Pacific/Honolulu', 'Asia/Karachi']) {
      const d = new Date('2026-03-08T15:45:00Z');
      expect(zonedInputToDate(dateToZonedInput(d, tz), tz).toISOString()).toBe(d.toISOString());
    }
    // 2026-03-08: Chicago springs forward at 2 AM. 9 AM that day is CDT (UTC-5).
    expect(zonedToUtc('America/Chicago', 2026, 3, 8, 9, 0).toISOString()).toBe('2026-03-08T14:00:00.000Z');
    // 2026-11-01: back to CST (UTC-6).
    expect(zonedToUtc('America/Chicago', 2026, 11, 1, 9, 0).toISOString()).toBe('2026-11-01T15:00:00.000Z');
  });

  it('applies the shared calling window (weekdays 8:00-19:00 carrier time)', () => {
    // Wed 2026-11-11 in Chicago (UTC-6)
    expect(callableAt('America/Chicago', new Date('2026-11-11T13:59:00Z'))).toMatchObject({ callable: false, reason: 'early' }); // 7:59
    expect(callableAt('America/Chicago', new Date('2026-11-11T14:00:00Z'))).toMatchObject({ callable: true }); // 8:00
    expect(callableAt('America/Chicago', new Date('2026-11-12T00:59:00Z'))).toMatchObject({ callable: true }); // 18:59
    expect(callableAt('America/Chicago', new Date('2026-11-12T01:00:00Z'))).toMatchObject({ callable: false, reason: 'late' }); // 19:00
    expect(callableAt('America/Chicago', new Date('2026-11-14T16:00:00Z'))).toMatchObject({ callable: false, reason: 'weekend' }); // Sat 10:00
    expect(windowFor({ state: 'TX' }, new Date('2026-11-11T15:00:00Z')).text).toBe('Prime window');
    expect(windowFor({}).text).toBe('Time zone unknown');
  });

  it('finds the next business day and next Monday in the carrier zone', () => {
    const fri = new Date('2026-11-13T18:00:00Z'); // Friday noon in Chicago
    const next = businessDayAt('America/Chicago', 1, 9, fri);
    expect(zonedParts('America/Chicago', next)).toMatchObject({ weekday: 'Mon', hour: 9, minute: 0, day: 16 });
    const two = businessDayAt('America/Chicago', 2, 9, fri);
    expect(zonedParts('America/Chicago', two)).toMatchObject({ weekday: 'Tue', day: 17 });
    const mon = nextMondayAt('America/New_York', 9, new Date('2026-11-16T15:00:00Z')); // a Monday: next week's Monday
    expect(zonedParts('America/New_York', mon)).toMatchObject({ weekday: 'Mon', day: 23, hour: 9 });
  });

  it('resolves the carrier zone from the stored zone or the state', () => {
    expect(tzOf({ timezone: 'America/Denver', state: 'TX' })).toBe('America/Denver');
    expect(tzOf({ state: 'ga' })).toBe('America/New_York');
    expect(tzOf({})).toBeNull();
    expect(zoneAbbr('America/Chicago', new Date('2026-07-01T12:00:00Z'))).toBe('CT');
  });
});
