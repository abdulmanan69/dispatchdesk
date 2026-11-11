import { describe, it, expect } from 'vitest';
import { app } from './helpers.js'; // eslint-disable-line no-unused-vars -- loads the app before route modules
import { docChecklist } from '../src/routes/customers.js';

describe('customer document checklist', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  it('counts an e-signed onboarding agreement as on file when no agreement file exists', () => {
    const list = docChecklist([], now, { id: 'link1', signedAt: new Date('2026-11-10T15:00:00Z') });
    const agreement = list.find((x) => x.type === 'agreement');
    expect(agreement).toMatchObject({ status: 'on_file', signedOnline: true, onboardingLinkId: 'link1' });
    expect(list.filter((x) => x.status === 'missing').map((x) => x.type)).toEqual(['mc_authority', 'w9', 'coi']);
  });
  it('prefers an uploaded agreement file and reports missing without either', () => {
    const doc = { id: 'd1', type: 'agreement', createdAt: new Date('2026-11-01'), expiresAt: null };
    expect(docChecklist([doc], now, { id: 'link1', signedAt: now }).find((x) => x.type === 'agreement')).toMatchObject({ status: 'on_file', documentId: 'd1' });
    expect(docChecklist([], now).find((x) => x.type === 'agreement').status).toBe('missing');
  });
});
