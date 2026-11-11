import { describe, it, expect } from 'vitest';
import { EMPTY_FORM, MAX_BROKERS, detailsPayload, lanesLabel, pickerExtra, postStatus, sendBlocker } from './truckPosts.js';

describe('truck post helpers', () => {
  it('sends only the details the user filled in', () => {
    expect(detailsPayload(EMPTY_FORM)).toEqual({});
    const out = detailsPayload({ ...EMPTY_FORM, location: ' Waco, TX ', rate: '$2.75/mi', availableAt: '2026-11-12T08:00' });
    expect(out.location).toBe('Waco, TX');
    expect(out.rate).toBe('$2.75/mi');
    expect(new Date(out.availableAt).getTime()).toBe(new Date('2026-11-12T08:00').getTime());
    expect(detailsPayload({ ...EMPTY_FORM, availableAt: 'not a date' })).toEqual({});
  });

  it('fills the template picker with stored values, overridden by the form', () => {
    const values = { truck_location: 'Dallas, TX', equipment: 'Dry van', available_date: 'now' };
    expect(pickerExtra(values, EMPTY_FORM)).toEqual(values);
    expect(pickerExtra(values, { ...EMPTY_FORM, location: 'Waco, TX', availableAt: '2026-11-12T08:00' }, () => 'Thu 8 AM'))
      .toEqual({ truck_location: 'Waco, TX', equipment: 'Dry van', available_date: 'Thu 8 AM' });
  });

  it('labels statuses and lanes', () => {
    expect(postStatus('scheduled')).toEqual(['blue', 'Queued']);
    expect(postStatus('replied')).toEqual(['teal', 'Replied']);
    expect(postStatus('weird')).toEqual(['gray', 'weird']);
    expect(lanesLabel([{ from: 'TX', to: 'GA', loads: 3 }, { from: 'GA', to: 'TX', loads: 1 }])).toBe('TX to GA (3), GA to TX (1)');
  });

  it('explains what is missing before a post can go out', () => {
    expect(sendBlocker({ truck: null, brokerCount: 1, subject: 's', body: 'b' })).toBe('Pick a truck');
    expect(sendBlocker({ truck: {}, brokerCount: 0, subject: 's', body: 'b' })).toBe('Pick at least one broker');
    expect(sendBlocker({ truck: {}, brokerCount: MAX_BROKERS + 1, subject: 's', body: 'b' })).toMatch(/at most 30/);
    expect(sendBlocker({ truck: {}, brokerCount: 2, subject: ' ', body: 'b' })).toBe('Write a subject and a message');
    expect(sendBlocker({ truck: {}, brokerCount: 2, subject: 's', body: 'b' })).toBeNull();
  });
});
