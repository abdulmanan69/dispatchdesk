import { Suspense, useEffect, useState } from 'react';
import { isRouteErrorResponse, Link, useLocation, useNavigate, useRouteError } from 'react-router';
import { RefreshCw, ArrowLeft } from 'lucide-react';
import { Button, Loading } from '../components/ui.jsx';
import { useAuth } from './AuthContext.jsx';
import { importWithReload, isChunkError, reloadForNewVersion } from './reload.js';

/**
 * Building blocks for the route table in src/router.jsx: lazy page and layout loaders (with the one-time reload on a
 * missing chunk after a deploy), the permission guard, and the error screens.
 */

let routerRef = null;
/** Let the loaders see where a navigation is going (router.jsx calls this once). */
export function bindRouter(router) { routerRef = router; }
/** The page being navigated to, so a reload after a deploy opens it (and not the page the user is leaving). */
export const pendingHref = () => {
  const loc = routerRef?.state?.navigation?.location;
  return loc ? `${loc.pathname}${loc.search}${loc.hash}` : null;
};

/** Route `lazy` for a page module (default export), wrapped in Suspense for any lazy parts inside the page. */
export const page = (load, wrap) => async () => {
  const mod = await importWithReload(load, pendingHref)();
  const C = mod.default;
  function RoutePage() {
    const el = <Suspense fallback={<Loading />}><C /></Suspense>;
    return wrap ? wrap(el) : el;
  }
  return { Component: RoutePage };
};
/** Route `lazy` for a layout module. */
export const layout = (load) => async () => ({ Component: (await importWithReload(load, pendingHref)()).default });

/** Route guard for permission-gated pages (the backend enforces permissions on every call too). */
export function RequirePermission({ perm, children }) {
  const { can, loading } = useAuth();
  if (loading) return <Loading />;
  if (!can(perm)) return <div className="py-16 text-center"><p className="font-medium">Access denied</p><p className="mt-1 text-sm text-muted">Your role does not include access to this area.</p></div>;
  return children;
}
export const requires = (perm) => (el) => <RequirePermission perm={perm}>{el}</RequirePermission>;

export function NotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <p className="text-5xl font-semibold text-muted/40 tabular">404</p>
      <h1 className="mt-3 text-lg font-semibold">Page not found</h1>
      <p className="mt-1 text-sm text-muted">The page you're looking for doesn't exist or was moved.</p>
      <Link to="/" className="mt-5 inline-block text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">Back to home</Link>
    </div>
  );
}

export function ErrorScreen({ error, inShell }) {
  const navigate = useNavigate();
  const location = useLocation();
  const chunk = isChunkError(error);
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    if (chunk && reloadForNewVersion()) setReloading(true);
  }, [chunk]);
  useEffect(() => {
    if (!chunk) console.error('[page error]', error);
  }, [chunk, error]);

  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  const box = inShell ? 'mx-auto max-w-md px-4 py-16 text-center' : 'mx-auto max-w-md px-4 py-24 text-center';
  if (chunk) {
    return (
      <div className={box} role="status">
        <h1 className="text-lg font-semibold">DispatchDesk was updated</h1>
        <p className="mt-1 text-sm text-muted">{reloading ? 'Loading the latest version…' : 'Reload to get the latest version.'}</p>
        {!reloading && <Button className="mt-5" icon={RefreshCw} onClick={() => window.location.reload()}>Reload</Button>}
      </div>
    );
  }
  return (
    <div className={box} role="alert">
      <h1 className="text-lg font-semibold">Something went wrong on this page</h1>
      <p className="mt-1 text-sm text-muted">{inShell ? 'The rest of the app still works. Try again, or go back to where you were.' : 'Try again, or reload the page.'}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button icon={RefreshCw} onClick={() => navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true })}>Try again</Button>
        {inShell && window.history.length > 1 && <Button variant="secondary" icon={ArrowLeft} onClick={() => navigate(-1)}>Go back</Button>}
        <Button variant="ghost" onClick={() => window.location.reload()}>Reload page</Button>
      </div>
    </div>
  );
}

export function RouteError() {
  return <ErrorScreen error={useRouteError()} />;
}
export function PageError() {
  return <ErrorScreen error={useRouteError()} inShell />;
}
