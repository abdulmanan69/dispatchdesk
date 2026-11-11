import { describe, it, expect } from 'vitest';
import { statusToast } from './useTripStatus.js';

describe('trip status toast', () => {
  it('points to the missing POD or rate con with a link to the load documents', () => {
    expect(statusToast({ trip: { id: 'l1', status: 'delivered' }, paperwork: { missing: ['pod'] } })).toEqual({
      type: 'info', message: 'Trip is now delivered. No POD on file yet.', action: { label: 'Upload POD', href: '/app/loads?load=l1&tab=documents' },
    });
    expect(statusToast({ trip: { id: 'l2', status: 'booked' }, paperwork: { missing: ['rate_confirmation'] } }).action.label).toBe('Upload rate con');
  });

  it('is a plain success when nothing is missing', () => {
    expect(statusToast({ trip: { id: 'l3', status: 'in_transit' }, paperwork: { missing: [] } })).toEqual({ type: 'success', message: 'Trip is now in transit' });
    expect(statusToast({ trip: { id: 'l4', status: 'planned' } })).toEqual({ type: 'success', message: 'Trip is now planned' });
  });
});
