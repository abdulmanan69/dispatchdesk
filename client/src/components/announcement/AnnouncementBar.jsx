import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { X } from 'lucide-react';
import { api } from '../../lib/api.js';
import { cx } from '../ui.jsx';

const KEY = 'dd:announcement-dismissed';
const TONE = {
  info: 'border-brand-600/20 bg-brand-600/10 text-fg',
  success: 'border-c-green/30 bg-c-green-soft text-fg',
  warning: 'border-c-amber/30 bg-c-amber-soft text-fg',
};
const DOT = { info: 'bg-brand-600', success: 'bg-c-green', warning: 'bg-c-amber' };

const dismissedId = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

/**
 * The site-wide announcement an administrator sets (Admin → System settings → Announcement). `place` is 'app' (signed
 * in) or 'public' (the website); the admin chooses where it shows. Each viewer can close it; a new text shows again.
 */
export default function AnnouncementBar({ place }) {
  const q = useQuery({ queryKey: ['announcement'], queryFn: () => api.get('/api/public/announcement'), staleTime: 5 * 60_000, retry: false });
  const [closed, setClosed] = useState(dismissedId);
  const a = q.data?.announcement;
  if (!a || closed === a.id) return null;
  if (a.audience !== 'everyone' && a.audience !== place) return null;
  const tone = TONE[a.tone] ? a.tone : 'info';
  const internal = a.linkUrl && a.linkUrl.startsWith('/') && !a.linkUrl.startsWith('//');
  const linkClass = 'shrink-0 font-medium underline underline-offset-2';
  const close = () => { try { localStorage.setItem(KEY, a.id); } catch { /* storage unavailable */ } setClosed(a.id); };
  return (
    <div role="region" aria-label="Announcement" className={cx('flex items-center gap-x-3 border-b px-4 py-2 text-[13px] sm:px-6', TONE[tone])}>
      <span className={cx('size-1.5 shrink-0 rounded-full', DOT[tone])} aria-hidden />
      <p className="min-w-0 flex-1">
        {a.text}
        {a.linkUrl && (
          <>
            {' '}
            {internal ? <Link to={a.linkUrl} className={linkClass}>{a.linkLabel || 'Learn more'}</Link>
              : <a href={a.linkUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>{a.linkLabel || 'Learn more'}</a>}
          </>
        )}
      </p>
      <button type="button" onClick={close} aria-label="Close announcement" className="shrink-0 rounded p-1 text-muted hover:text-fg"><X className="size-3.5" /></button>
    </div>
  );
}
