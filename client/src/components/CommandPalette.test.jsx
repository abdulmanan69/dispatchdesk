import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/api.js', () => ({ api: { get: vi.fn() } }));
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ can: () => true }) }));

const { searchTerms } = await import('./CommandPalette.jsx');

describe('searchTerms', () => {
  it('sends the plain query to every list', () => {
    expect(searchTerms('  Red River ')).toEqual({ carriers: 'Red River', loads: 'Red River', brokers: 'Red River' });
  });

  it('strips a leading # for load references', () => {
    expect(searchTerms('#4417').loads).toBe('4417');
    expect(searchTerms('# 4417').loads).toBe('4417');
  });

  it('strips an MC prefix for broker MC numbers', () => {
    expect(searchTerms('MC 123456').brokers).toBe('123456');
    expect(searchTerms('mc#123456').brokers).toBe('123456');
    expect(searchTerms('MC-123456').brokers).toBe('123456');
    // A name that starts with "mc" is not an MC number.
    expect(searchTerms('McKenzie Logistics').brokers).toBe('McKenzie Logistics');
  });

  it('skips terms shorter than 2 characters', () => {
    expect(searchTerms('a')).toEqual({ carriers: null, loads: null, brokers: null });
    expect(searchTerms('#4').loads).toBeNull();
  });
});
