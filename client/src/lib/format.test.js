import { describe, it, expect } from 'vitest';
import { money, dollars, num, date, dateTime, relative, nf, dtf, zoneClock } from './format.js';

describe('format', () => {
  it('formats money and numbers', () => {
    expect(money(123456)).toBe('$1,234.56');
    expect(money(123456, { digits: 0 })).toBe('$1,235');
    expect(money(null)).toBe('—');
    expect(dollars(2.5)).toBe('$2.50');
    expect(num(1234.567, 1)).toBe('1,234.6');
  });

  it('reuses one formatter per set of options', () => {
    expect(nf({ maximumFractionDigits: 2 })).toBe(nf({ maximumFractionDigits: 2 }));
    expect(dtf({ timeZone: 'America/Chicago', hour: 'numeric' })).toBe(dtf({ timeZone: 'America/Chicago', hour: 'numeric' }));
    expect(nf({ maximumFractionDigits: 1 })).not.toBe(nf({ maximumFractionDigits: 2 }));
  });

  it('formats dates and handles bad input', () => {
    const d = new Date(2026, 10, 12, 15, 4);
    expect(date(d)).toBe('Nov 12, 2026');
    expect(date(d, { month: 'short', day: 'numeric' })).toBe('Nov 12');
    expect(dateTime(d)).toMatch(/^Nov 12, 3:04\s?PM$/);
    expect(date('not a date')).toBe('—');
    expect(dateTime(null)).toBe('—');
    expect(relative(new Date(Date.now() - 5 * 60000))).toBe('5 minutes ago');
    expect(relative(new Date(Date.now() + 2 * 86400000))).toBe('in 2 days');
  });

  it('reads a zone clock from one formatter', () => {
    const c = zoneClock(new Date(Date.UTC(2026, 10, 12, 15, 30)), 'America/Chicago');
    expect(c).toMatchObject({ time: '9:30', ampm: 'am', hour24: 9 });
    expect(c.abbr).toMatch(/^C[SD]T$/);
    const pm = zoneClock(new Date(Date.UTC(2026, 10, 12, 23, 5)), 'America/New_York');
    expect(pm).toMatchObject({ time: '6:05', ampm: 'pm', hour24: 18 });
    const noon = zoneClock(new Date(Date.UTC(2026, 10, 12, 18, 0)), 'America/Chicago');
    expect(noon.hour24).toBe(12);
    const midnight = zoneClock(new Date(Date.UTC(2026, 10, 12, 6, 0)), 'America/Chicago');
    expect(midnight.hour24).toBe(0);
  });
});
