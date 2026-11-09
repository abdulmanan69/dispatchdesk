import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { cx } from '../ui.jsx';

/**
 * Weekly retail diesel price for the carrier's region (U.S. EIA). Quiet when the price source isn't set up:
 * admins get a pointer to the setting, everyone else sees nothing.
 */
export default function DieselCard({ state }) {
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ['market', 'diesel', state || 'US'],
    queryFn: () => api.get('/api/market/diesel', state ? { state } : {}),
    staleTime: 3600000,
    retry: false,
  });
  const admin = can?.('admin.settings');
  if (q.isLoading) return null;
  const d = q.data;
  if (q.isError || !d || d.configured === false || d.price == null) {
    if (!admin) return null;
    return (
      <div className="rounded-xl border border-dashed border-line px-4 py-3 text-xs text-muted">
        Diesel price needs an EIA key. <Link to="/app/admin?tab=settings" className="text-brand-700 underline-offset-2 hover:underline dark:text-brand-300">Admin → Settings</Link>
      </div>
    );
  }
  const change = Number(d.change);
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <p className="text-xs text-muted">Diesel · {d.regionLabel || d.region || 'United States'}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-medium tabular">${Number(d.price).toFixed(2)}</span>
        <span className="text-xs text-muted">/gal</span>
        {Number.isFinite(change) && change !== 0 && (
          <span className={cx('text-xs tabular', change > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400')}>
            {change > 0 ? 'Up' : 'Down'} ${Math.abs(change).toFixed(2)}
          </span>
        )}
      </div>
      <p className="mt-1 text-[11.5px] text-muted">
        {d.period && <>Week of {d.period} · </>}Source{' '}
        {d.sourceUrl ? <a href={d.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">{d.source || 'EIA'}</a> : (d.source || 'EIA')}
      </p>
    </div>
  );
}
