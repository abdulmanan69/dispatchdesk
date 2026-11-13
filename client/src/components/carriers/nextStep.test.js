import { describe, it, expect } from 'vitest';
import { nextStepFor } from './nextStep.js';

const NOW = new Date('2026-11-13T15:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const carrier = (over = {}) => ({
  id: 'c1', phone: '2145550188', email: 'a@b.com', doNotCall: false, doNotEmail: false, authorityStatus: 'active',
  stage: { key: 'lead' }, followUps: [], enrollments: [], lastContactedAt: null, onboarding: null, fmcsaVerdict: null, ...over,
});

describe('nextStepFor', () => {
  it('a new lead: make the first call, with the local-time hint', () => {
    const s = nextStepFor(carrier(), { now: NOW, callWindow: { localTime: '9:00 AM', callable: true } });
    expect(s).toMatchObject({ key: 'first_touch', title: 'Make the first call', action: { kind: 'call' } });
    expect(s.detail).toBe('It is 9:00 AM there: a good time to call.');
    expect(nextStepFor(carrier({ doNotCall: true }), { now: NOW }).action).toEqual({ kind: 'email', label: 'Email' });
  });

  it('blocks work on a carrier FMCSA does not allow to haul', () => {
    const s = nextStepFor(carrier({ fmcsaVerdict: { level: 'fail', text: 'No liability (BIPD) insurance on file' } }), { now: NOW });
    expect(s).toMatchObject({ key: 'check', tone: 'red', detail: 'No liability (BIPD) insurance on file', action: { kind: 'check' } });
    expect(nextStepFor(carrier({ authorityStatus: 'inactive', operatingStatus: 'Authority inactive' }), { now: NOW }).key).toBe('check');
  });

  it('an overdue follow-up comes first', () => {
    const s = nextStepFor(carrier({ lastContactedAt: daysAgo(3), followUps: [{ status: 'pending', title: 'Call back about rates', dueAt: daysAgo(1) }] }), { now: NOW });
    expect(s).toMatchObject({ key: 'followup_due', tone: 'red', title: 'Overdue: Call back about rates', action: { kind: 'call', label: 'Call now' } });
  });

  it('contacted with nothing scheduled: schedule a follow-up, amber once the record goes stale', () => {
    expect(nextStepFor(carrier({ lastContactedAt: daysAgo(2) }), { now: NOW })).toMatchObject({ key: 'followup_missing', tone: 'brand', action: { kind: 'followup' } });
    expect(nextStepFor(carrier({ stage: { key: 'prospecting' }, lastContactedAt: daysAgo(9) }), { now: NOW })).toMatchObject({ tone: 'amber', title: 'No contact in 9 days' });
  });

  it('opportunity: send the agreement, chase it, then convert', () => {
    const opp = { stage: { key: 'opportunity' }, lastContactedAt: daysAgo(1) };
    expect(nextStepFor(carrier(opp), { now: NOW })).toMatchObject({ key: 'agreement_send', action: { kind: 'onboarding', label: 'Send agreement link' } });
    expect(nextStepFor(carrier({ ...opp, onboarding: { status: 'pending', sentAt: daysAgo(3), viewedAt: daysAgo(2) } }), { now: NOW }))
      .toMatchObject({ key: 'agreement_waiting', tone: 'amber', title: 'They opened the agreement but have not signed', action: { kind: 'call' } });
    expect(nextStepFor(carrier({ ...opp, onboarding: { status: 'expired', sentAt: daysAgo(20) } }), { now: NOW }).title).toBe('Send a new agreement link');
    expect(nextStepFor(carrier({ ...opp, onboarding: { status: 'signed', sentAt: daysAgo(3), signedAt: daysAgo(1) } }), { now: NOW }))
      .toMatchObject({ key: 'agreement_signed', tone: 'green', action: { kind: 'convert', label: 'Move to Customers' } });
  });

  it('customers, sequences and archived carriers', () => {
    expect(nextStepFor(carrier({ stage: { key: 'customer' }, customer: { id: 'k1' } }), { now: NOW }).action).toEqual({ kind: 'customer', label: 'Open customer' });
    const seq = nextStepFor(carrier({ lastContactedAt: daysAgo(1), enrollments: [{ status: 'active', sequence: { name: 'New MC' }, step: { order: 2, type: 'email' }, nextStepAt: new Date(NOW.getTime() + 86_400_000).toISOString() }] }), { now: NOW });
    expect(seq).toMatchObject({ key: 'sequence', title: 'In sequence: New MC', detail: 'Step 2 (email) in 1 day. A reply stops it.' });
    expect(nextStepFor(carrier({ stage: { key: 'archived' } }), { now: NOW }).action).toBeNull();
  });
});
