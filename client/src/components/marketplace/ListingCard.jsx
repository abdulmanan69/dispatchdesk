import { Link } from 'react-router';
import { MapPin, ImageOff } from 'lucide-react';
import { Badge } from '../ui.jsx';
import { label, money, relative } from '../../lib/format.js';

export const MARKET_CATEGORIES = ['dispatch_tools', 'training', 'software', 'services', 'hiring', 'employment', 'consulting'];
export const PRICE_TYPES = [
  ['fixed', 'Fixed price'],
  ['hourly', 'Per hour'],
  ['monthly', 'Per month'],
  ['free', 'Free'],
  ['contact', 'Contact for price'],
];

export function priceLabel(l) {
  if (l.priceType === 'free') return 'Free';
  if (l.priceType === 'contact' || l.priceCents == null) return 'Contact for price';
  const amount = money(l.priceCents, { digits: l.priceCents % 100 ? 2 : 0 });
  return l.priceType === 'hourly' ? `${amount}/hr` : l.priceType === 'monthly' ? `${amount}/mo` : amount;
}

export function ListingCard({ listing }) {
  return (
    <Link to={`/marketplace/${listing.id}`} className="group flex flex-col overflow-hidden rounded-xl border border-line bg-surface transition-colors hover:border-brand-300/70">
      <div className="aspect-[16/9] bg-surface-2">
        {listing.imageUrl ? (
          <img src={listing.imageUrl} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <div className="flex size-full items-center justify-center text-muted/50"><ImageOff className="size-6" aria-hidden /></div>
        )}
      </div>
      <div className="flex flex-1 flex-col p-3.5">
        <div className="mb-1.5"><Badge color="brand">{label(listing.category)}</Badge></div>
        <h3 className="line-clamp-2 text-[14.5px] font-medium leading-snug group-hover:underline">{listing.title}</h3>
        <p className="mt-1 text-sm font-medium tabular text-brand-700 dark:text-brand-300">{priceLabel(listing)}</p>
        <div className="mt-auto flex items-center gap-2 pt-3 text-xs text-muted">
          {listing.location && <span className="inline-flex min-w-0 items-center gap-1"><MapPin className="size-3 shrink-0" aria-hidden /><span className="truncate">{listing.location}</span></span>}
          <span className="ml-auto shrink-0">{relative(listing.createdAt)}</span>
        </div>
      </div>
    </Link>
  );
}
