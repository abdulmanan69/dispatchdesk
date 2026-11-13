import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import LeadFilters, {
  LEAD_FILTER_DEFAULTS, activeLeadFilters, leadFiltersFromCriteria, leadFiltersToCriteria, leadFiltersToQuery,
} from './LeadFilters.jsx';

function Harness({ initial = LEAD_FILTER_DEFAULTS, onState }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <LeadFilters value={v} onChange={(next) => { setV(next); onState?.(next); }} insurerSuggestions={['Progressive', 'Canal', 'Great West']} />
      <output data-testid="state">{JSON.stringify(v)}</output>
    </>
  );
}
const state = () => JSON.parse(screen.getByTestId('state').textContent);
/** The themed Select is a combobox button with a listbox. */
const choose = (label, option) => { fireEvent.click(screen.getByLabelText(label)); fireEvent.click(screen.getByRole('option', { name: option })); };

describe('lead filter helpers', () => {
  it('defaults match the server: exclude Unsatisfactory, leave out shared contacts, nothing else on', () => {
    expect(leadFiltersToCriteria(LEAD_FILTER_DEFAULTS)).toEqual({
      zipPrefixes: [], counties: [], interstateOnly: false, forHireOnly: false, hazmat: 'any',
      minDrivers: null, maxDrivers: null, minCdlDrivers: null, maxMilesPerTruck: null, mcAgeMinDays: null, mcAgeMaxDays: null, mcs150WithinMonths: null,
      excludeRatings: ['U'], requireCell: false, requireCellOrEmail: false, excludeSharedContacts: true, excludeEmail: 'none',
      equipment: [], insurers: [], insurerMode: 'include',
    });
    expect(leadFiltersToQuery(LEAD_FILTER_DEFAULTS)).toEqual({});
    expect(activeLeadFilters(LEAD_FILTER_DEFAULTS)).toBe(0);
  });

  it('round-trips stored criteria through the form state', () => {
    const criteria = {
      zipPrefixes: ['773', '750'], counties: ['201'], interstateOnly: true, forHireOnly: false, hazmat: 'no',
      minDrivers: 1, maxDrivers: 4, minCdlDrivers: 1, maxMilesPerTruck: 60000, mcAgeMinDays: 30, mcAgeMaxDays: 120, mcs150WithinMonths: 6,
      excludeRatings: ['C', 'U'], requireCell: true, requireCellOrEmail: false, excludeSharedContacts: false, excludeEmail: 'corporate',
      equipment: ['reefer', 'hotshot'], insurers: ['Progressive'], insurerMode: 'exclude',
    };
    const form = leadFiltersFromCriteria({ ...criteria, states: ['TX'], playbook: 'new_mc_launch' });
    expect(form).toMatchObject({ zipPrefixes: '773, 750', counties: '201', minDrivers: '1', maxMilesPerTruck: '60000', excludeSharedContacts: false });
    expect(leadFiltersToCriteria(form)).toEqual(criteria);
    // Old generators without these keys get the defaults.
    expect(leadFiltersFromCriteria({ states: ['OH'], cargo: [] })).toEqual({ ...LEAD_FILTER_DEFAULTS });
  });

  it('query parameters carry only what differs from the defaults; an empty rating list is "none"', () => {
    const f = {
      ...LEAD_FILTER_DEFAULTS, zipPrefixes: '773, 750 ', interstateOnly: true, hazmat: 'yes', maxMilesPerTruck: '60000', excludeRatings: [],
      excludeSharedContacts: false, excludeEmail: 'free', equipment: ['reefer', 'flatbed'], insurers: ['Progressive', 'Canal'], insurerMode: 'exclude',
    };
    expect(leadFiltersToQuery(f)).toEqual({
      zipPrefixes: '773,750', interstateOnly: 'true', hazmat: 'yes', maxMilesPerTruck: '60000', excludeRatings: 'none',
      excludeSharedContacts: 'false', excludeEmail: 'free', equipment: 'reefer,flatbed', insurers: 'Progressive,Canal', insurerMode: 'exclude',
    });
    expect(leadFiltersToQuery({ ...LEAD_FILTER_DEFAULTS, excludeRatings: ['U', 'C'] })).toEqual({ excludeRatings: 'C,U' });
  });
});

describe('LeadFilters form', () => {
  it('shows the groups collapsed and opens one on click', () => {
    render(<Harness />);
    for (const name of ['Location', 'Operation', 'Size and equipment', 'Authority and safety', 'Contact quality', 'Insurer']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-expanded', 'false');
    }
    expect(screen.queryByLabelText('ZIP prefixes')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Location/ }));
    fireEvent.change(screen.getByLabelText('ZIP prefixes'), { target: { value: '773' } });
    expect(state().zipPrefixes).toBe('773');
    expect(screen.getByRole('button', { name: /^Location/ })).toHaveTextContent('(1 on)');
  });

  it('toggles operation, safety and contact options, with shared contacts left out by default', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^Operation/ }));
    fireEvent.click(screen.getByLabelText('Interstate only'));
    choose('Hazmat', 'No hazmat');
    fireEvent.click(screen.getByRole('button', { name: /^Authority and safety/ }));
    expect(screen.getByLabelText('Leave out Unsatisfactory safety ratings')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Leave out Conditional safety ratings'));
    fireEvent.change(screen.getByLabelText('MC age up to (days)'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: /^Contact quality/ }));
    const shared = screen.getByLabelText('Leave out shared contacts');
    expect(shared).toBeChecked();
    expect(screen.getByText(/3 or more carriers usually belongs to a dispatch service/)).toBeInTheDocument();
    fireEvent.click(shared);
    fireEvent.click(screen.getByLabelText('Has a cell phone'));
    expect(state()).toMatchObject({ interstateOnly: true, hazmat: 'no', excludeRatings: ['C', 'U'], mcAgeMaxDays: '120', excludeSharedContacts: false, requireCell: true });
  });

  it('picks equipment with chips', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^Size and equipment/ }));
    const group = screen.getByRole('group', { name: 'Equipment' });
    fireEvent.click(within(group).getByRole('button', { name: 'Reefer' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Hotshot' }));
    expect(within(group).getByRole('button', { name: 'Reefer' })).toHaveAttribute('aria-pressed', 'true');
    expect(state().equipment).toEqual(['reefer', 'hotshot']);
  });

  it('adds insurers by typing (Add button or Enter) or by picking a suggestion, and removes them', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^Insurer/ }));
    const input = screen.getByLabelText('Insurer name');
    fireEvent.change(input, { target: { value: 'Northland' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(input, { target: { value: 'Sentry' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'Prog' } });
    fireEvent.click(screen.getByRole('option', { name: 'Progressive' }));
    expect(state().insurers).toEqual(['Northland', 'Sentry', 'Progressive']);
    const chips = screen.getByRole('list', { name: 'Insurers' });
    expect(within(chips).getByText('Sentry')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sentry' }));
    choose('Insurer rule', 'Insurer is not one of these');
    expect(state()).toMatchObject({ insurers: ['Northland', 'Progressive'], insurerMode: 'exclude' });
  });
});
