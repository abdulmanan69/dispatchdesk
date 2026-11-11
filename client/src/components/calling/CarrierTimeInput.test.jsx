import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import CarrierTimeInput from './CarrierTimeInput.jsx';
import { browserTz, dateToZonedInput } from './callWindow.js';

function Harness({ timezone, onValue }) {
  const [v, setV] = useState('');
  return <CarrierTimeInput aria-label="When" timezone={timezone} value={v} onChange={(x) => { setV(x); onValue(x); }} />;
}

/** A zone that differs from the browser's right now, so the toggle is shown. */
const otherZone = () => (dateToZonedInput(new Date(), 'Pacific/Honolulu') === dateToZonedInput(new Date(), browserTz()) ? 'Asia/Tokyo' : 'Pacific/Honolulu');

describe('CarrierTimeInput', () => {
  it('reads the typed time in the carrier zone by default and shows your time alongside', () => {
    const tz = otherZone();
    const onValue = vi.fn();
    render(<Harness timezone={tz} onValue={onValue} />);
    fireEvent.change(screen.getByLabelText('When'), { target: { value: '2026-11-12T15:00' } });
    const iso = onValue.mock.calls.at(-1)[0];
    expect(dateToZonedInput(iso, tz)).toBe('2026-11-12T15:00');
    expect(screen.getByRole('radio', { name: /carrier time/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/your time/)).toBeInTheDocument();
  });

  it('switching to my time keeps the typed clock time and reads it in your zone', () => {
    const tz = otherZone();
    const onValue = vi.fn();
    render(<Harness timezone={tz} onValue={onValue} />);
    fireEvent.change(screen.getByLabelText('When'), { target: { value: '2026-11-12T15:00' } });
    fireEvent.click(screen.getByRole('radio', { name: /my time/i }));
    const iso = onValue.mock.calls.at(-1)[0];
    expect(dateToZonedInput(iso, browserTz())).toBe('2026-11-12T15:00');
    expect(screen.getByLabelText('When')).toHaveValue('2026-11-12T15:00');
  });

  it('shows the saved moment in the new carrier zone when the carrier changes', () => {
    const first = otherZone();
    const second = first === 'Asia/Tokyo' ? 'Pacific/Honolulu' : 'Asia/Tokyo';
    const onChange = vi.fn();
    const iso = new Date('2026-11-12T21:00:00Z').toISOString();
    const { rerender } = render(<CarrierTimeInput aria-label="When" timezone={first} value={iso} onChange={onChange} />);
    expect(screen.getByLabelText('When')).toHaveValue(dateToZonedInput(iso, first));
    rerender(<CarrierTimeInput aria-label="When" timezone={second} value={iso} onChange={onChange} />);
    // Same instant, new wall clock: what is shown is what will be saved.
    expect(screen.getByLabelText('When')).toHaveValue(dateToZonedInput(iso, second));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('works in your own zone when the carrier zone is unknown', () => {
    const onValue = vi.fn();
    render(<Harness timezone={null} onValue={onValue} />);
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.getByText(/time zone unknown/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('When'), { target: { value: '2026-11-12T09:30' } });
    expect(dateToZonedInput(onValue.mock.calls.at(-1)[0], browserTz())).toBe('2026-11-12T09:30');
  });
});
