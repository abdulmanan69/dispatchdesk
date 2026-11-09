import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Mail, MapPin, Pencil, Send, ShieldAlert } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { date, label } from '../../lib/format.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Avatar, Badge, Button, Card, Markdown, QueryState, Textarea } from '../../components/ui.jsx';
import { ListingCard, priceLabel } from '../../components/marketplace/ListingCard.jsx';
import { ReportButton } from '../../components/community/ReportModal.jsx';
import { useConfirm } from '../../components/Modal.jsx';

function ContactForm({ listing }) {
  const { user } = useAuth();
  const location = useLocation();
  const [body, setBody] = useState('');
  const [sent, setSent] = useState(false);
  const send = useApiMutation((text) => api.post(`/api/marketplace/listings/${listing.id}/contact`, { body: text }), {
    success: 'Message sent', invalidate: [['marketplace', 'inbox']], onSuccess: () => { setSent(true); setBody(''); },
  });
  if (!user) {
    return (
      <div className="text-sm">
        <p className="text-muted">Sign in to message the seller.</p>
        <Button className="mt-3 w-full" to={`/login?next=${encodeURIComponent(location.pathname)}`}>Log in to contact</Button>
      </div>
    );
  }
  if (listing.isOwner) return <p className="text-sm text-muted">This is your listing. Messages from buyers appear in your marketplace inbox.</p>;
  if (sent) {
    return (
      <div className="text-sm">
        <p className="font-medium">Your message was sent.</p>
        <p className="mt-1 text-muted">Replies appear in your inbox and notifications.</p>
        <div className="mt-3 flex gap-2">
          <Button size="sm" to={`/app/marketplace?tab=inbox&listing=${listing.id}&user=${listing.seller.id}`}>Open conversation</Button>
          <Button size="sm" variant="secondary" onClick={() => setSent(false)}>Send another</Button>
        </div>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (body.trim()) send.mutate(body.trim()); }} className="space-y-2.5">
      <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} placeholder={`Hi ${listing.seller.name.split(' ')[0]}, I'm interested in…`} aria-label="Message to seller" />
      <Button type="submit" icon={Send} loading={send.isPending} disabled={!body.trim()} className="w-full">Send message</Button>
    </form>
  );
}

function ModeratorBar({ listing }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const moderate = useApiMutation((status) => api.post(`/api/marketplace/listings/${listing.id}/moderate`, { status }), {
    invalidate: [['marketplace']], success: (_, s) => `Listing ${s === 'active' ? 'restored' : s}`,
  });
  const del = useApiMutation(() => api.del(`/api/marketplace/listings/${listing.id}`), { invalidate: [['marketplace']], success: 'Listing deleted', onSuccess: () => navigate('/marketplace') });
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm dark:border-amber-900 dark:bg-amber-950/30">
      <ShieldAlert className="size-4 text-amber-700" aria-hidden />
      <span className="mr-auto font-medium">Moderation · status: {label(listing.status)}</span>
      {listing.status !== 'active' && <Button size="sm" variant="secondary" onClick={() => moderate.mutate('active')}>Restore</Button>}
      {listing.status !== 'hidden' && <Button size="sm" variant="secondary" onClick={() => moderate.mutate('hidden')}>Hide</Button>}
      {listing.status !== 'removed' && <Button size="sm" variant="danger" onClick={() => moderate.mutate('removed')}>Remove</Button>}
      <Button size="sm" variant="ghost" onClick={async () => { if (await confirm({ title: 'Delete listing?', message: 'This listing and its conversations will be permanently deleted.', danger: true })) del.mutate(); }}>Delete</Button>
    </div>
  );
}

export default function ListingDetail() {
  const { id } = useParams();
  const { user, can } = useAuth();
  const q = useQuery({ queryKey: ['marketplace', 'listing', id, !!user], queryFn: () => api.get(`/api/marketplace/listings/${id}`) });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <Link to="/marketplace" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="size-4" />Marketplace</Link>
      <div className="mt-4">
        <QueryState query={q}>
          {({ listing, moreFromSeller }) => (
            <>
              {can('admin.moderate') && !listing.isOwner && <ModeratorBar listing={listing} />}
              {listing.isOwner && listing.status !== 'active' && (
                <p className="mb-4 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm">This listing is <strong>{label(listing.status)}</strong> and not visible to others.</p>
              )}
              <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
                <div className="min-w-0">
                  {listing.imageUrl && <img src={listing.imageUrl} alt="" className="mb-5 max-h-[420px] w-full rounded-lg border border-line object-cover" />}
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge color="brand">{label(listing.category)}</Badge>
                    {listing.location && <span className="inline-flex items-center gap-1 text-sm text-muted"><MapPin className="size-3.5" aria-hidden />{listing.location}</span>}
                  </div>
                  <h1 className="mt-2 text-2xl font-medium tracking-[-0.01em]">{listing.title}</h1>
                  <p className="mt-1 text-lg font-medium tabular text-brand-700 dark:text-brand-300">{priceLabel(listing)}</p>
                  <p className="mt-1 text-xs text-muted">Posted {date(listing.createdAt)}{listing.updatedAt !== listing.createdAt ? ` · updated ${date(listing.updatedAt)}` : ''}</p>
                  <Card className="mt-5"><Markdown text={listing.description} /></Card>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {listing.isOwner && <Button variant="secondary" icon={Pencil} to={`/app/marketplace/${listing.id}/edit`}>Edit listing</Button>}
                    {!listing.isOwner && <ReportButton url={`/api/marketplace/listings/${listing.id}/report`} what="listing" />}
                  </div>
                </div>
                <aside className="space-y-4">
                  <Card title="Seller">
                    <Link to={`/u/${listing.seller.id}`} className="flex items-center gap-3 hover:underline">
                      <Avatar name={listing.seller.name} src={listing.seller.avatarUrl} size={40} />
                      <div>
                        <p className="font-medium">{listing.seller.name}</p>
                        <p className="text-xs text-muted">Member since {date(listing.seller.memberSince, { month: 'short', year: 'numeric' })}</p>
                      </div>
                    </Link>
                    {(listing.contactEmail || listing.websiteUrl) && (
                      <div className="mt-4 space-y-1.5 text-sm">
                        {listing.contactEmail && <a href={`mailto:${listing.contactEmail}`} className="flex items-center gap-2 text-brand-700 hover:underline dark:text-brand-300"><Mail className="size-4" aria-hidden />{listing.contactEmail}</a>}
                        {listing.websiteUrl && <a href={listing.websiteUrl} target="_blank" rel="noopener noreferrer nofollow" className="flex items-center gap-2 text-brand-700 hover:underline dark:text-brand-300"><ExternalLink className="size-4" aria-hidden />Website</a>}
                      </div>
                    )}
                  </Card>
                  <Card title="Message the seller"><ContactForm listing={listing} /></Card>
                  <p className="text-xs text-muted">The platform does not process payments between users. Agree terms directly with the seller and never send money to someone you have not verified.</p>
                </aside>
              </div>
              {moreFromSeller.length > 0 && (
                <section className="mt-10">
                  <h2 className="mb-3 text-sm font-medium">More from {listing.seller.name}</h2>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{moreFromSeller.map((l) => <ListingCard key={l.id} listing={l} />)}</div>
                </section>
              )}
            </>
          )}
        </QueryState>
      </div>
    </div>
  );
}
