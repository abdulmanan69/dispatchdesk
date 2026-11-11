import { describe, it, expect } from 'vitest';
import { addDays, addMonths, calendarEvents, monthGrid, placeEvents, queryRange, startOfWeek, timeLabel, weekGrid } from './LoadCalendar.jsx';

describe('calendar grids', () => {
  it('covers whole Sunday-first weeks of the month', () => {
    const nov = monthGrid('2026-11-11');
    expect(nov[0]).toBe('2026-11-01'); // Nov 1 2026 is a Sunday
    expect(nov).toHaveLength(35);
    expect(nov.at(-1)).toBe('2026-12-05');
    const aug = monthGrid('2026-08-20'); // Aug 1 is a Saturday: six weeks
    expect(aug[0]).toBe('2026-07-26');
    expect(aug).toHaveLength(42);
    expect(weekGrid('2026-11-11')).toEqual(['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
    expect(startOfWeek('2026-11-08')).toBe('2026-11-08');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-01');
    expect(queryRange(weekGrid('2026-11-11'))).toEqual({ from: '2026-11-07', to: '2026-11-15' });
  });
});

describe('calendar placement', () => {
  const load = (extra) => ({ id: 'l1', status: 'booked', referenceNumber: 'R1', originCity: 'Los Angeles', originState: 'CA', destCity: 'Phoenix', destState: 'AZ', ...extra });

  it('places each stop on its facility local day', () => {
    const events = calendarEvents([load({
      // 11:30 PM Pacific on Monday is Tuesday in UTC; delivery 6:00 AM Phoenix on Wednesday.
      pickupWindowStart: '2026-11-17T07:30:00Z', pickupTz: 'America/Los_Angeles', pickupDate: '2026-11-16T20:00:00Z',
      deliveryWindowStart: '2026-11-18T13:00:00Z', deliveryTz: 'America/Phoenix', deliveryDate: '2026-11-18T19:00:00Z',
    })]);
    expect(events.map((e) => [e.kind, e.day])).toEqual([['pickup', '2026-11-16'], ['delivery', '2026-11-18']]);
    expect(timeLabel(events[0])).toBe('11:30 PM PST');
    expect(timeLabel(events[1])).toBe('6:00 AM MST');
  });

  it('falls back to the stop date without an appointment, and skips stops with neither', () => {
    const events = calendarEvents([load({ pickupDate: '2026-11-16T18:00:00Z', pickupTz: 'America/New_York' })]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'pickup', day: '2026-11-16', at: null });
    expect(timeLabel(events[0])).toBe('');
  });

  it('sorts a day by time, untimed stops last and pickups first', () => {
    const tz = 'America/Chicago';
    const events = calendarEvents([
      load({ id: 'late', pickupWindowStart: '2026-11-16T20:00:00Z', pickupTz: tz }),
      load({ id: 'early', pickupWindowStart: '2026-11-16T14:00:00Z', pickupTz: tz }),
      load({ id: 'dateonly', pickupDate: '2026-11-16T18:00:00Z', pickupTz: tz, deliveryDate: '2026-11-16T18:00:00Z', deliveryTz: tz }),
      load({ id: 'other', pickupWindowStart: '2026-11-20T14:00:00Z', pickupTz: tz }),
    ]);
    const days = weekGrid('2026-11-16');
    const map = placeEvents(events, days);
    expect(map.get('2026-11-16').map((e) => `${e.load.id}:${e.kind}`)).toEqual(['early:pickup', 'late:pickup', 'dateonly:pickup', 'dateonly:delivery']);
    expect(map.get('2026-11-20').map((e) => e.load.id)).toEqual(['other']);
    expect(map.get('2026-11-17')).toEqual([]);
    expect(placeEvents(events, ['2026-12-01']).get('2026-12-01')).toEqual([]);
  });
});
