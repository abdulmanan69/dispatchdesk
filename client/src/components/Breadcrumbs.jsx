import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';

/** Visible breadcrumb trail; the server writes the same trail as BreadcrumbList data for search results. */
export default function Breadcrumbs({ trail, className = '' }) {
  if (!trail || trail.length < 2) return null;
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-1 text-[13px] text-muted">
        {trail.map((c, i) => (
          <li key={c.path} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-3.5 shrink-0" aria-hidden />}
            {i === trail.length - 1
              ? <span aria-current="page" className="text-fg-2">{c.name}</span>
              : <Link to={c.path} className="rounded transition-ui hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">{c.name}</Link>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
