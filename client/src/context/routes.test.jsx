import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, Outlet, Link } from 'react-router';
import { page, PageError, RouteError, bindRouter } from './routes.jsx';

vi.mock('./AuthContext.jsx', () => ({ useAuth: () => ({ can: () => true, loading: false }) }));

let reload;
let assign;
beforeEach(() => {
  sessionStorage.clear();
  reload = vi.fn();
  assign = vi.fn();
  bindRouter(null);
  vi.stubGlobal('location', { ...window.location, reload, assign });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function Shell() {
  return (
    <div>
      <nav><Link to="/ok">Go to a working page</Link></nav>
      <p>Sidebar and header</p>
      <Outlet />
    </div>
  );
}
function Boom() { throw new Error('Render failed'); }

const routes = () => [{
  element: <Shell />,
  errorElement: <RouteError />,
  children: [{
    errorElement: <PageError />,
    children: [
      { path: '/boom', element: <Boom /> },
      { path: '/ok', element: <p>Working page</p> },
      { path: '/lazy', lazy: page(async () => ({ default: () => <p>Lazy page loaded</p> })) },
      { path: '/stale', lazy: page(async () => { throw new TypeError('Failed to fetch dynamically imported module: /assets/Old-123.js'); }) },
    ],
  }],
}];

describe('route error handling', () => {
  it('shows a page crash inside the shell, and navigation keeps working', async () => {
    const router = createMemoryRouter(routes(), { initialEntries: ['/boom'] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByText('Something went wrong on this page')).toBeInTheDocument();
    expect(screen.getByText('Sidebar and header')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Go to a working page'));
    expect(await screen.findByText('Working page')).toBeInTheDocument();
  });

  it('loads lazy pages through the page() helper', async () => {
    const router = createMemoryRouter(routes(), { initialEntries: ['/lazy'] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByText('Lazy page loaded')).toBeInTheDocument();
  });

  it('reloads once when a page chunk from an old build is missing', async () => {
    const router = createMemoryRouter(routes(), { initialEntries: ['/ok'] });
    render(<RouterProvider router={router} />);
    await screen.findByText('Working page');
    act(() => { router.navigate('/stale'); });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    // The reload is under way: the current page stays instead of an error screen.
    expect(screen.queryByText('Something went wrong on this page')).toBeNull();
  });

  it('reloads straight into the page the user was opening', async () => {
    const router = createMemoryRouter(routes(), { initialEntries: ['/ok'] });
    bindRouter(router);
    render(<RouterProvider router={router} />);
    await screen.findByText('Working page');
    act(() => { router.navigate('/stale?tab=x'); });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/stale?tab=x'));
    expect(reload).not.toHaveBeenCalled();
  });

  it('explains an update instead of looping when the reload did not help', async () => {
    sessionStorage.setItem('dd:chunk-reload', String(Date.now())); // just reloaded
    const router = createMemoryRouter(routes(), { initialEntries: ['/stale'] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByText('DispatchDesk was updated')).toBeInTheDocument();
    expect(screen.getByText('Sidebar and header')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /reload/i }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
