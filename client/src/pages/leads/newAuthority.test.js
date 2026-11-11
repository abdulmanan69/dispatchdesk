import { describe, it, expect } from 'vitest';
import { WINDOWS, ageLabel, claimSummary, rowStatus } from './newAuthority.js';

describe('new-authority helpers', () => {
  it('labels authority age honestly', () => {
    expect(ageLabel(null)).toBe('Date unknown');
    expect(ageLabel(0)).toBe('Today');
    expect(ageLabel(1)).toBe('1 day ago');
    expect(ageLabel(45)).toBe('45 days ago');
  });

  it('tells mine, teammate and new rows apart', () => {
    expect(rowStatus({ existsInCrm: true, existingId: 'c1' })).toBe('mine');
    expect(rowStatus({ existsInCrm: false, teamClaims: [{ ownerName: 'Ana' }] })).toBe('team');
    expect(rowStatus({ existsInCrm: false, teamClaims: [] })).toBe('new');
  });

  it('summarizes a claim without inventing numbers', () => {
    expect(claimSummary({ created: 2, skipped: 1, limited: 0, notFound: 0 })).toBe('Added 2 to your list · 1 already there');
    expect(claimSummary({ created: 1, skipped: 0, limited: 3, notFound: 1, enrolled: 1, sequence: { name: 'New MC' } }))
      .toBe('Added 1 to your list · 3 over your plan limit · 1 not found in the census · 1 added to New MC');
  });

  it('matches the server windows', () => {
    expect(WINDOWS.map((w) => w.key)).toEqual(['new7', 'new30', 'new90', 'new180', 'turning90', 'turning180']);
  });
});
