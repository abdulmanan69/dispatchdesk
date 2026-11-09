import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, X } from 'lucide-react';
import { api } from '../../lib/api.js';
import { label } from '../../lib/format.js';
import { useToast } from '../../components/Toast.jsx';
import { Button, Card, Field, Input, Markdown, PageHeader, QueryState, Select, Textarea } from '../../components/ui.jsx';
import { MARKET_CATEGORIES, PRICE_TYPES } from '../../components/marketplace/ListingCard.jsx';

const EMPTY = { title: '', category: 'services', description: '', priceType: 'fixed', price: '', location: '', contactEmail: '', websiteUrl: '' };

function Form({ listing }) {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef(null);
  const [form, setForm] = useState(() => (listing ? {
    title: listing.title, category: listing.category, description: listing.description, priceType: listing.priceType,
    price: listing.priceCents != null ? (listing.priceCents / 100).toString() : '', location: listing.location || '',
    contactEmail: listing.contactEmail || '', websiteUrl: listing.websiteUrl || '',
  } : EMPTY));
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(listing?.imageUrl || null);
  const [removeImage, setRemoveImage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [error, setError] = useState(null);
  const needsPrice = ['fixed', 'hourly', 'monthly'].includes(form.priceType);

  useEffect(() => () => { if (preview?.startsWith('blob:')) URL.revokeObjectURL(preview); }, [preview]);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const pickFile = (f) => {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast.error('Image must be 5 MB or smaller'); return; }
    setFile(f);
    setRemoveImage(false);
    setPreview(URL.createObjectURL(f));
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const body = {
      title: form.title, category: form.category, description: form.description, priceType: form.priceType,
      priceCents: needsPrice && form.price !== '' ? Math.round(Number(form.price) * 100) : null,
      location: form.location, contactEmail: form.contactEmail, websiteUrl: form.websiteUrl,
    };
    try {
      const res = listing ? await api.patch(`/api/marketplace/listings/${listing.id}`, body) : await api.post('/api/marketplace/listings', body);
      const id = res.listing.id;
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        try { await api.upload(`/api/marketplace/listings/${id}/image`, fd); }
        catch (err) { toast.error(`Listing saved, but the image upload failed: ${err.message}`); }
      } else if (removeImage && listing?.imageUrl) {
        await api.del(`/api/marketplace/listings/${id}/image`);
      }
      await qc.invalidateQueries({ queryKey: ['marketplace'] });
      toast.success(listing ? 'Listing updated' : 'Listing published');
      navigate(`/marketplace/${id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-5 lg:grid-cols-[1fr_300px]">
      <Card>
        <div className="space-y-4">
          <Field label="Title" required><Input value={form.title} onChange={set('title')} maxLength={140} required placeholder="e.g. Reefer dispatch service for owner-operators" /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Category" required>
              <Select value={form.category} onChange={set('category')}>{MARKET_CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select>
            </Field>
            <Field label="Location" hint="City, state or Remote"><Input value={form.location} onChange={set('location')} maxLength={120} /></Field>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor="listing-desc" className="text-[13px] font-medium">Description <span className="text-red-600">*</span></label>
              <button type="button" className="text-xs text-brand-700 hover:underline dark:text-brand-300" onClick={() => setShowPreview(!showPreview)}>{showPreview ? 'Edit' : 'Preview'}</button>
            </div>
            {showPreview
              ? <div className="min-h-40 rounded-md border border-line bg-bg p-3"><Markdown text={form.description || '*Nothing to preview*'} /></div>
              : <Textarea id="listing-desc" rows={10} value={form.description} onChange={set('description')} maxLength={8000} required />}
            <p className="mt-1 text-xs text-muted">Markdown supported: **bold**, lists, links.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Price type">
              <Select value={form.priceType} onChange={set('priceType')}>{PRICE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            </Field>
            {needsPrice && (
              <Field label="Price (USD)" required>
                <Input type="number" min="0" step="0.01" inputMode="decimal" value={form.price} onChange={set('price')} required />
              </Field>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Contact email" hint="Shown to signed-in members only."><Input type="email" value={form.contactEmail} onChange={set('contactEmail')} /></Field>
            <Field label="Website"><Input type="url" value={form.websiteUrl} onChange={set('websiteUrl')} placeholder="https://" /></Field>
          </div>
          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        </div>
      </Card>
      <div className="space-y-4">
        <Card title="Image">
          {preview && !removeImage ? (
            <div className="relative">
              <img src={preview} alt="Listing preview" className="aspect-[16/9] w-full rounded-md border border-line object-cover" />
              <button type="button" aria-label="Remove image" onClick={() => { setFile(null); setPreview(null); setRemoveImage(true); if (fileRef.current) fileRef.current.value = ''; }}
                className="absolute right-2 top-2 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"><X className="size-4" /></button>
            </div>
          ) : (
            <button type="button" onClick={() => fileRef.current?.click()} className="flex aspect-[16/9] w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-line text-sm text-muted hover:bg-surface-2">
              <ImagePlus className="size-5" aria-hidden />Add an image
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => pickFile(e.target.files?.[0])} />
          <p className="mt-2 text-xs text-muted">PNG, JPG, WebP or GIF up to 5 MB.</p>
        </Card>
        <div className="flex gap-2">
          <Button type="submit" loading={busy} className="flex-1">{listing ? 'Save changes' : 'Publish listing'}</Button>
          <Button variant="secondary" to="/app/marketplace">Cancel</Button>
        </div>
        <p className="text-xs text-muted">Listings must describe a real offer. Payments happen directly between members; the platform does not process them.</p>
      </div>
    </form>
  );
}

export default function ListingForm() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['marketplace', 'listing', id, true], queryFn: () => api.get(`/api/marketplace/listings/${id}`), enabled: !!id });
  return (
    <>
      <PageHeader
        breadcrumb={<Link to="/app/marketplace" className="hover:underline">Marketplace</Link>}
        title={id ? 'Edit listing' : 'Post a listing'}
        subtitle="Offer a dispatch service, tool, training or job to the community."
      />
      {id ? (
        <QueryState query={q}>
          {(d) => (d.listing.isOwner ? <Form listing={d.listing} /> : <Card><p className="text-sm text-muted">You can only edit your own listings.</p></Card>)}
        </QueryState>
      ) : <Form />}
    </>
  );
}
