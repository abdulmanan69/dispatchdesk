import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const post = vi.fn();
vi.mock('../../lib/api.js', () => ({ api: { post: (...a) => post(...a) } }));
vi.mock('../calling/CallButton.jsx', () => ({ default: () => null }));

const { AuthorityBadge, authorityProblem } = await import('./shared.jsx');
const { saveCensusLeads, saveAnywayPrompt } = await import('./saveLeads.js');

beforeEach(() => post.mockReset());

describe('AuthorityBadge', () => {
  it.each([
    ['inactive', 'Authority inactive', 'red'],
    ['pending', 'Authority pending', 'amber'],
    ['none', 'No MC authority', 'gray'],
    ['active', 'Active', 'green'],
    ['unknown', 'Not verified', 'gray'],
  ])('%s shows "%s"', (status, text, color) => {
    render(<AuthorityBadge status={status} detail="Authority inactive (FMCSA licensing)" />);
    const badge = screen.getByText(text);
    expect(badge).toHaveAttribute('title', 'Authority inactive (FMCSA licensing)');
    expect(badge.className).toContain(`bg-c-${color}-soft`); // Badge color classes from ui.jsx
  });

  it('shows a dash without a status', () => {
    render(<AuthorityBadge status={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('flags statuses that cannot haul for hire', () => {
    expect(['inactive', 'pending', 'none'].every(authorityProblem)).toBe(true);
    expect(['active', 'unknown', null].some(authorityProblem)).toBe(false);
  });
});

describe('saveCensusLeads (save anyway)', () => {
  const refused = { created: 0, skipped: 0, limited: 0, notFound: 0, inactiveAuthority: 1, unverified: 0, ids: [], items: [{ dotNumber: '1775913', id: null, status: 'inactive_authority', companyName: 'DERICK DORIAN MYRICK', authority: { status: 'inactive', label: 'Authority inactive (FMCSA licensing)' } }] };

  it('asks "Authority is not active. Save anyway?" and saves with allowInactive when confirmed', async () => {
    post.mockResolvedValueOnce(refused).mockResolvedValueOnce({ created: 1, inactiveAuthority: 0, ids: ['c1'], items: [{ dotNumber: '1775913', id: 'c1', status: 'created' }] });
    const confirm = vi.fn().mockResolvedValue(true);
    const res = await saveCensusLeads({ dots: ['1775913'], sequenceId: '', confirm });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Authority is not active', confirmLabel: 'Save anyway', message: expect.stringMatching(/DERICK DORIAN MYRICK: Authority inactive \(FMCSA licensing\)\..*Save anyway\?$/) }));
    expect(post).toHaveBeenNthCalledWith(1, '/api/discovery/save', { dotNumbers: ['1775913'], sequenceId: null });
    expect(post).toHaveBeenNthCalledWith(2, '/api/discovery/save', { dotNumbers: ['1775913'], sequenceId: null, allowInactive: true });
    expect(res).toMatchObject({ created: 1, inactiveAuthority: 0, ids: ['c1'], items: [{ dotNumber: '1775913', id: 'c1', status: 'created' }] });
  });

  it('keeps the carrier unsaved when the user says no', async () => {
    post.mockResolvedValueOnce(refused);
    const confirm = vi.fn().mockResolvedValue(false);
    const res = await saveCensusLeads({ dots: ['1775913'], confirm });
    expect(post).toHaveBeenCalledTimes(1);
    expect(res.inactiveAuthority).toBe(1);
  });

  it('does not ask when everything was saved', async () => {
    post.mockResolvedValueOnce({ created: 1, items: [{ dotNumber: '1', id: 'c1', status: 'created' }] });
    const confirm = vi.fn();
    await saveCensusLeads({ dots: ['1'], confirm });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('words carriers that could not be verified differently', () => {
    expect(saveAnywayPrompt([{ dotNumber: '1', status: 'unverified' }])).toMatchObject({ title: 'Operating authority not verified', message: expect.stringMatching(/^Could not verify operating authority with FMCSA right now/) });
  });
});
