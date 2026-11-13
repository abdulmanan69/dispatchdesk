import { describe, it, expect } from 'vitest';
import { vettingChecklist } from './vetting.js';

const base = {
  authority: { status: 'active', code: 'active', since: '2021-08-26', ageYears: 5.2, insuranceOnFile: true },
  insurance: { onFile: [{ category: 'bipd', coverage: 750000, company: 'GEICO MARINE INSURANCE COMPANY' }] },
  safety: { available: true, rating: null },
  flags: [{ level: 'green', code: 'authority_active', text: 'Authority active, insurance on file' }],
};
const inspections = (over = {}) => ({
  data: {
    summary: { inspections: 12, vehicle: { oosRate: 10, nationalAvg: 23.2 }, driver: { oosRate: 0, nationalAvg: 6.4 } },
    crashes: { total: 0 }, flags: [], ...over,
  },
});
const related = (over = {}) => ({ data: { total: 0, flags: [], ...over } });
const row = (c, key) => c.rows.find((r) => r.key === key);

describe('vettingChecklist', () => {
  it('passes a clean carrier with the reason on each row', () => {
    const c = vettingChecklist({ profile: base, inspections: inspections(), related: related() });
    expect(c.verdict).toMatchObject({ level: 'pass', label: 'No red flags' });
    expect(row(c, 'authority').text).toBe('Active, granted Aug 26, 2021 (5 yrs)');
    expect(row(c, 'insurance').text).toBe('BIPD $750,000 · GEICO MARINE INSURANCE COMPANY');
    expect(row(c, 'safety').text).toMatch(/Not rated/);
    expect(row(c, 'inspections').text).toBe('12 inspections: vehicle OOS 10% (avg 23.2%), driver OOS 0% (avg 6.4%), no crashes');
    expect(row(c, 'identity').text).toBe('No other carrier shares its phone, email or address');
  });

  it('a red flag makes the verdict "Do not book"; amber ones "Review before booking"', () => {
    const bad = vettingChecklist({ profile: { ...base, flags: [{ level: 'red', code: 'no_insurance', text: 'No liability (BIPD) insurance on file' }] }, inspections: inspections(), related: related() });
    expect(bad.verdict).toMatchObject({ level: 'fail', label: 'Do not book', reason: 'No liability (BIPD) insurance on file' });
    expect(row(bad, 'insurance').level).toBe('fail');
    const review = vettingChecklist({
      profile: base,
      inspections: inspections({ flags: [{ level: 'amber', code: 'oos_vehicle', text: 'Vehicle out-of-service rate 30%' }] }),
      related: related({ flags: [{ level: 'amber', code: 'related_inactive', text: 'Shares phone with 1 inactive carrier' }] }),
    });
    expect(review.verdict).toMatchObject({ level: 'warn', label: 'Review before booking' });
    expect(review.verdict.reason).toBe('2 things to check: inspections and crashes, identity and contact');
  });

  it('the inspection report replaces QCMobile\'s own OOS flags; loading rows say "Checking"', () => {
    const profile = { ...base, flags: [...base.flags, { level: 'amber', code: 'high_oos_vehicle', text: 'QCMobile says high' }] };
    const loading = vettingChecklist({ profile, inspections: { isLoading: true }, related: { isLoading: true } });
    expect(row(loading, 'inspections')).toMatchObject({ level: 'warn', text: 'QCMobile says high' });
    expect(row(loading, 'identity')).toMatchObject({ level: 'pending', text: 'Checking…' });
    const loaded = vettingChecklist({ profile, inspections: inspections(), related: related() });
    expect(row(loaded, 'inspections').level).toBe('pass');
    const none = vettingChecklist({ profile: base, inspections: inspections({ summary: { inspections: 0, vehicle: {}, driver: {} } }), related: { isError: true } });
    expect(row(none, 'inspections')).toMatchObject({ level: 'unknown', text: 'No roadside inspections in the last 24 months' });
    expect(row(none, 'identity')).toMatchObject({ level: 'unknown', text: 'Not available right now' });
  });
});
