import { describe, it, expect } from 'vitest';
import { clock, editorToBody, formToTemplate, recurrenceSummary, templateToInitial } from './LoadTemplates.jsx';
import { loadToForm } from './LoadForm.jsx';

const form = {
  ...loadToForm({}),
  originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', rate: '2100', loadedMiles: '780', equipment: 'dry_van',
  pickupDate: '2026-11-16', deliveryDate: '2026-11-17', pickupWindowStart: '2026-11-16T08:00', pickupWindowEnd: '2026-11-16T10:00',
  deliveryWindowStart: '2026-11-17T06:00', deliveryWindowEnd: '', referenceNumber: 'PER-LOAD', status: 'booked', carrierId: 'c1', detentionRate: '50',
};

describe('load templates', () => {
  it('turns the load form into template fields with times of day and transit days', () => {
    const t = formToTemplate(form);
    expect(t.carrierId).toBe('c1');
    expect(t.fields).toMatchObject({
      originCity: 'Dallas', rateCents: 210000, loadedMiles: '780', detentionRateCents: 5000,
      pickupWindowStart: '08:00', pickupWindowEnd: '10:00', deliveryWindowStart: '06:00', deliveryWindowEnd: null, transitDays: 1,
    });
    expect(t.fields.referenceNumber).toBeUndefined();
    expect(t.fields.status).toBeUndefined();
    expect(formToTemplate({ ...form, deliveryDate: '', deliveryWindowStart: '' }).fields.transitDays).toBeNull();
  });

  it('fills a new load for the chosen pickup day, overnight windows included', () => {
    const t = {
      id: 't1', carrierId: 'c1', brokerId: null, carrier: { companyName: 'Blue Truck LLC' }, pickupTime: '22:00',
      fields: { originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', rateCents: 210000, loadedMiles: 780, pickupTz: 'America/Chicago', deliveryTz: 'America/New_York', pickupWindowStart: '22:00', pickupWindowEnd: '02:00', deliveryWindowStart: '14:00', transitDays: 2 },
    };
    const init = templateToInitial(t, '2026-12-31');
    expect(init).toMatchObject({
      pickupDate: '2026-12-31', deliveryDate: '2027-01-02', pickupWindowStart: '2026-12-31T22:00', pickupWindowEnd: '2027-01-01T02:00',
      deliveryWindowStart: '2027-01-02T14:00', deliveryWindowEnd: null, carrierId: 'c1', carrierLabel: 'Blue Truck LLC', status: 'planned',
    });
    const f = loadToForm(init);
    expect(f).toMatchObject({ rate: '2100', loadedMiles: '780', pickupWindowStart: '2026-12-31T22:00', pickupTz: 'America/Chicago', pickupDate: '2026-12-31', carrierId: 'c1' });
  });

  it('describes the schedule', () => {
    expect(clock('08:00')).toBe('8:00 AM');
    expect(clock('13:05')).toBe('1:05 PM');
    expect(clock('00:30')).toBe('12:30 AM');
    expect(recurrenceSummary({ weekdays: [] })).toBe('Template only');
    expect(recurrenceSummary({ weekdays: [1, 3, 5], pickupTime: '08:00', leadDays: 7, pickupTz: null })).toBe('Mon, Wed, Fri at 8:00 AM · loads 7 days ahead');
    expect(recurrenceSummary({ weekdays: [1, 2, 3, 4, 5], pickupTime: '06:30', leadDays: 1 })).toBe('Weekdays at 6:30 AM · loads 1 day ahead');
    expect(recurrenceSummary({ weekdays: [0, 1, 2, 3, 4, 5, 6], pickupTime: '06:30', leadDays: 3 })).toMatch(/^Every day/);
  });

  it('keeps fields the lane editor does not show, and lets the server pick the zones again', () => {
    const existing = { id: 't1', fields: { originCity: 'Dallas', mpg: 6.5, dispatchFeePercent: 8, pickupTz: 'America/Chicago', deliveryTz: 'America/New_York' } };
    const body = editorToBody({
      name: ' Lane ', originCity: 'El Paso', originState: 'TX', destCity: 'Atlanta', destState: 'GA', pickupFacility: '', deliveryFacility: '', rate: '1500', loadedMiles: '1400',
      equipment: '', commodity: '', weightLbs: '', notes: '', carrierId: null, brokerId: null, weekdays: [1, 4], pickupTime: '07:00', pickupUntil: '',
      deliveryTime: '', deliveryUntil: '', transitDays: '2', leadDays: '10', active: true,
    }, existing);
    expect(body).toMatchObject({ name: 'Lane', weekdays: [1, 4], pickupTime: '07:00', leadDays: 10, active: true });
    expect(body.fields).toMatchObject({ originCity: 'El Paso', mpg: 6.5, dispatchFeePercent: 8, rateCents: 150000, pickupWindowStart: '07:00', transitDays: '2' });
    expect(body.fields.pickupTz).toBeUndefined();
  });
});
