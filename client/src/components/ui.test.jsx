import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { renderMarkdown, DataTable, Field, Input, Pagination, Badge, Select, ComboInput } from './ui.jsx';

describe('renderMarkdown', () => {
  it('escapes HTML so user content cannot inject scripts', () => {
    const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('only links http(s) and relative URLs', () => {
    expect(renderMarkdown('[ok](https://fmcsa.dot.gov)')).toContain('href="https://fmcsa.dot.gov"');
    expect(renderMarkdown('[bad](javascript:alert(1))')).not.toContain('href="javascript');
  });

  it('renders headings, lists, bold and tables', () => {
    const html = renderMarkdown('# Title\n- one\n- **two**\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<ul><li>one</li><li><strong>two</strong></li></ul>');
    expect(html).toContain('<td>1</td>');
  });
});

describe('Field', () => {
  it('associates the label with its input', () => {
    render(<Field label="MC number"><Input /></Field>);
    expect(screen.getByLabelText('MC number')).toBeInstanceOf(HTMLInputElement);
  });
  it('shows an error message and marks the input invalid', () => {
    render(<Field label="Email" error="Invalid email"><Input /></Field>);
    expect(screen.getByText('Invalid email')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('DataTable', () => {
  const rows = [{ id: 'a', name: 'Alpha Freight' }, { id: 'b', name: 'Bravo Transport' }];
  const columns = [{ key: 'name', header: 'Company', sortable: true }];

  it('renders rows and handles sort clicks', () => {
    const onSort = vi.fn();
    render(<DataTable columns={columns} rows={rows} sort={{ field: 'name', dir: 'asc' }} onSort={onSort} />);
    expect(screen.getByText('Alpha Freight')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /company/i }));
    expect(onSort).toHaveBeenCalledWith({ field: 'name', dir: 'desc' });
  });

  it('supports select-all', () => {
    const onSelect = vi.fn();
    render(<DataTable columns={columns} rows={rows} selected={new Set()} onSelect={onSelect} />);
    fireEvent.click(screen.getByLabelText('Select all'));
    expect([...onSelect.mock.calls[0][0]]).toEqual(['a', 'b']);
  });

  it('shows the empty state when there are no rows', () => {
    render(<DataTable columns={columns} rows={[]} />);
    expect(screen.getByText('No records')).toBeInTheDocument();
  });
});

describe('Pagination and Badge', () => {
  it('pages forward', () => {
    const onPage = vi.fn();
    render(<Pagination page={1} pages={3} total={60} onPage={onPage} />);
    fireEvent.click(screen.getByLabelText('Next page'));
    expect(onPage).toHaveBeenCalledWith(2);
    expect(screen.getByLabelText('Previous page')).toBeDisabled();
  });
  it('renders badge text', () => {
    render(<Badge color="green">Active</Badge>);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });
});

describe('themed Select', () => {
  it('opens a listbox, picks an option and reports e.target.value', async () => {
    const onChange = vi.fn();
    render(<Field label="Equipment"><Select value="" onChange={onChange}><option value="">Any</option><option value="reefer">Reefer</option><optgroup label="Open deck"><option value="flatbed">Flatbed</option></optgroup></Select></Field>);
    const trigger = screen.getByLabelText('Equipment');
    expect(trigger).toHaveAttribute('role', 'combobox');
    fireEvent.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByText('Open deck')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Flatbed' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ value: 'flatbed' }) }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
  it('supports keyboard selection and submits through a hidden input', () => {
    const { container } = render(<form><Select name="role" defaultValue="dispatcher"><option value="dispatcher">Dispatcher</option><option value="manager">Manager</option></Select></form>);
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('Dispatcher');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(trigger).toHaveTextContent('Manager');
    expect(container.querySelector('input[type=hidden][name=role]').value).toBe('manager');
  });
});

describe('themed ComboInput', () => {
  it('filters suggestions as you type and picks one', () => {
    const onChange = vi.fn();
    render(<ComboInput aria-label="Terms" options={['Net 30', 'Net 15', 'Quick pay 2%']} value="quick" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Terms'), { target: { value: 'quic' } });
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(1);
    fireEvent.click(opts[0]);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ target: expect.objectContaining({ value: 'Quick pay 2%' }) }));
  });
});
