import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Button, QueryState, ErrorBoundary, DataTable, Markdown, Checkbox } from './ui.jsx';

afterEach(() => { vi.restoreAllMocks(); });

describe('Button', () => {
  it('stays disabled while loading even when the caller passes disabled={false}', () => {
    const onClick = vi.fn();
    render(<Button loading disabled={false} onClick={onClick}>Send now</Button>);
    const btn = screen.getByRole('button', { name: /send now/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('cannot submit a form twice while the request runs', () => {
    const onSubmit = vi.fn((e) => e.preventDefault());
    function Form() {
      const [pending, setPending] = useState(false);
      return (
        <form onSubmit={(e) => { onSubmit(e); setPending(true); }}>
          <Button type="submit" loading={pending} disabled={false}>Save call</Button>
        </form>
      );
    }
    render(<Form />);
    const btn = screen.getByRole('button', { name: /save call/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(btn).toHaveAttribute('type', 'submit');
  });

  it('is clickable when neither loading nor disabled, and honours disabled alone', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<Button onClick={onClick} disabled>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled();
  });

  it('blocks link buttons while disabled or loading', () => {
    const onClick = vi.fn();
    render(<MemoryRouter><Button to="/app/billing" disabled onClick={onClick}>Billing</Button></MemoryRouter>);
    const link = screen.getByRole('link', { name: 'Billing' });
    expect(link).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(link);
    expect(onClick).not.toHaveBeenCalled();
  });
});

const baseQuery = (over) => ({ isLoading: false, isError: false, isRefetchError: false, isFetching: false, data: undefined, error: null, refetch: vi.fn(), ...over });

describe('QueryState', () => {
  it('shows a loading state, then the content', () => {
    const { rerender } = render(<QueryState query={baseQuery({ isLoading: true })}>{(d) => <p>{d.name}</p>}</QueryState>);
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);
    rerender(<QueryState query={baseQuery({ data: { name: 'Fleet' } })}>{(d) => <p>{d.name}</p>}</QueryState>);
    expect(screen.getByText('Fleet')).toBeInTheDocument();
  });

  it('shows the error screen only when nothing was loaded yet', () => {
    const q = baseQuery({ isError: true, error: new Error('Server unavailable') });
    render(<QueryState query={q}>{() => <p>never</p>}</QueryState>);
    expect(screen.getByRole('alert')).toHaveTextContent('Server unavailable');
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(q.refetch).toHaveBeenCalled();
  });

  it('keeps loaded data on screen when a background refetch fails, with a small retry notice', () => {
    const q = baseQuery({ isError: true, isRefetchError: true, error: new Error('429'), data: { name: 'Truck 12' } });
    render(<QueryState query={q}>{(d) => <p>{d.name}</p>}</QueryState>);
    expect(screen.getByText('Truck 12')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/couldn't refresh/i);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(q.refetch).toHaveBeenCalled();
  });

  it('renders the empty state through isEmpty', () => {
    render(<QueryState query={baseQuery({ data: { items: [] } })} isEmpty={(d) => !d.items.length} empty={<p>Nothing yet</p>}>{() => <p>list</p>}</QueryState>);
    expect(screen.getByText('Nothing yet')).toBeInTheDocument();
  });
});

describe('ErrorBoundary', () => {
  function Boom({ fail }) {
    if (fail) throw new Error('Chart crashed');
    return <p>Chart ok</p>;
  }

  it('contains a crash and recovers when resetKey changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    const { rerender } = render(<div><p>Rest of page</p><ErrorBoundary resetKey="a" onError={onError} fallback={(e) => <p>Fallback: {e.message}</p>}><Boom fail /></ErrorBoundary></div>);
    expect(screen.getByText('Rest of page')).toBeInTheDocument();
    expect(screen.getByText('Fallback: Chart crashed')).toBeInTheDocument();
    expect(onError).toHaveBeenCalled();
    rerender(<div><p>Rest of page</p><ErrorBoundary resetKey="b" fallback={(e) => <p>Fallback: {e.message}</p>}><Boom /></ErrorBoundary></div>);
    expect(screen.getByText('Chart ok')).toBeInTheDocument();
  });
});

describe('DataTable on phones', () => {
  it('renders cards from mobileRow next to the table', () => {
    const rows = [{ id: 'a', name: 'Alpha Freight', status: 'booked' }];
    render(<DataTable columns={[{ key: 'name', header: 'Company' }]} rows={rows} mobileRow={(r) => <span>{r.name} · {r.status}</span>} />);
    expect(screen.getByText('Alpha Freight · booked')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});

describe('Markdown and Checkbox', () => {
  it('Markdown is memoized and still escapes HTML', () => {
    expect(Markdown.$$typeof).toBe(Symbol.for('react.memo'));
    const { container } = render(<Markdown text={'**Bold** <img src=x onerror=alert(1)>'} />);
    expect(container.querySelector('strong')).toHaveTextContent('Bold');
    expect(container.querySelector('img')).toBeNull();
  });

  it('Checkbox is a labelled, themed checkbox', () => {
    render(<Checkbox label="Hide names" defaultChecked />);
    const box = screen.getByLabelText('Hide names');
    expect(box).toBeChecked();
    expect(box.className).toContain('accent-brand-600');
  });
});
