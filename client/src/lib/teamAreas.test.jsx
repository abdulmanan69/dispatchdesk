import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { areaOfPath, hasArea } from './teamAreas.js';

const auth = vi.hoisted(() => ({ user: null }));
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: auth.user, loading: false }) }));
const { RequireArea } = await import('../context/routes.jsx');

describe('team work areas', () => {
  it('knows which pages belong to which area', () => {
    expect(areaOfPath('/app/lead-generator')).toBe('sales');
    expect(areaOfPath('/app/sequences/abc')).toBe('sales');
    expect(areaOfPath('/app/loads/calculator')).toBe('dispatch');
    expect(areaOfPath('/app/carriers/abc')).toBeNull();
    expect(areaOfPath('/app/loadsXYZ')).toBeNull();
  });

  it('gives everyone outside a team, and members without a list, every area', () => {
    expect(hasArea(null, 'sales')).toBe(true);
    expect(hasArea({ team: null }, 'dispatch')).toBe(true);
    expect(hasArea({ team: { areas: ['sales'] } }, 'dispatch')).toBe(false);
    expect(hasArea({ team: { areas: ['sales'] } }, 'sales')).toBe(true);
  });

  it('shows a notice instead of a page whose area is off', () => {
    auth.user = { id: 'u1', team: { role: 'sales', areas: ['sales'] } };
    render(<MemoryRouter><RequireArea name="dispatch"><p>Loads page</p></RequireArea></MemoryRouter>);
    expect(screen.queryByText('Loads page')).toBeNull();
    expect(screen.getByText('Dispatch is not turned on for you')).toBeInTheDocument();
  });
});
