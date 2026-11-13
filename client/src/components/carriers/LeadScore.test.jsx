import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SignalChips, TierBadge, topReasons } from './LeadScore.jsx';

const SIGNALS = [
  { key: 'clean_history', label: 'No revocations or crash flags', points: 4, group: 'quality', tone: 'good' },
  { key: 'new_authority', label: 'New MC · 45 days', points: 25, group: 'need', tone: 'good' },
  { key: 'cell_phone', label: 'Cell phone', points: 14, group: 'reach', tone: 'good' },
  { key: 'owner_operator', label: 'Owner-operator · 1 truck', points: 10, group: 'fit', tone: 'good' },
  { key: 'eq_reefer', label: 'Reefer', points: 5, group: 'fit', tone: 'good' },
  { key: 'shared_contact', label: 'Shared contact · 7 carriers', points: -20, group: 'need', tone: 'bad' },
  { key: 'reinstated', label: 'Reinstated after revocation', points: 3, group: 'need', tone: 'warn' },
  { key: 'company_email', label: 'Company email domain', points: 0, group: 'reach', tone: 'info' },
];

describe('lead score display', () => {
  it('tier badge: A green, B amber, C gray, with the score', () => {
    const { rerender } = render(<TierBadge tier="A" score={82} />);
    expect(screen.getByText('A · 82')).toHaveClass('text-c-green');
    expect(screen.getByText('A · 82')).toHaveAttribute('title', 'Tier A · best fit · lead score 82/100');
    rerender(<TierBadge tier="B" score={60} />);
    expect(screen.getByText('B · 60')).toHaveClass('text-c-amber');
    rerender(<TierBadge tier="C" score={30} />);
    expect(screen.getByText('C · 30')).toHaveClass('text-fg-2');
    rerender(<TierBadge tier={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('chips: problems first and colored, quiet signals left out, the rest behind "+N more"', () => {
    render(<SignalChips signals={SIGNALS} max={4} />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['Shared contact · 7 carriers', 'Reinstated after revocation', 'New MC · 45 days', 'Cell phone', '+2 more']);
    expect(items[0]).toHaveClass('text-c-red');
    expect(items[1]).toHaveClass('text-c-amber');
    expect(items[2]).toHaveAttribute('title', 'New MC · 45 days (+25 Need)');
    expect(items[4]).toHaveAttribute('title', 'Owner-operator · 1 truck, Reefer');
    expect(screen.queryByText('Company email domain')).toBeNull();
    expect(screen.queryByText('No revocations or crash flags')).toBeNull();
  });

  it('top reasons are the strongest positive signals', () => {
    expect(topReasons(SIGNALS).map((s) => s.label)).toEqual(['New MC · 45 days', 'Cell phone', 'Owner-operator · 1 truck']);
    expect(topReasons('not an array')).toEqual([]);
  });
});
