import { useEffect, useState } from 'react';
import { Modal } from '../Modal.jsx';
import { Button, Field, Input, Markdown, Select, Textarea } from '../ui.jsx';
import { label } from '../../lib/format.js';
import { COMMUNITY_CATEGORIES } from './PostCard.jsx';

/** Create / edit post modal. onSubmit(body) returns a promise. */
export function PostEditor({ open, onClose, initial, onSubmit, busy }) {
  const [form, setForm] = useState({ title: '', body: '', category: 'general' });
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    if (open) { setForm({ title: initial?.title || '', body: initial?.body || '', category: initial?.category || 'general' }); setPreview(false); }
  }, [open, initial]);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} size="lg" title={initial ? 'Edit post' : 'New post'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="post-editor" loading={busy}>{initial ? 'Save changes' : 'Publish post'}</Button></>}>
      <form id="post-editor" className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSubmit(form); }}>
        <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
          <Field label="Title" required><Input value={form.title} onChange={set('title')} maxLength={200} required /></Field>
          <Field label="Category">
            <Select value={form.category} onChange={set('category')}>{COMMUNITY_CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select>
          </Field>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="post-body" className="text-[13px] font-medium">Post <span className="text-red-600">*</span></label>
            <button type="button" className="text-xs text-brand-700 hover:underline dark:text-brand-300" onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button>
          </div>
          {preview
            ? <div className="min-h-48 rounded-md border border-line bg-bg p-3"><Markdown text={form.body || '*Nothing to preview*'} /></div>
            : <Textarea id="post-body" rows={10} value={form.body} onChange={set('body')} maxLength={20000} required />}
          <p className="mt-1 text-xs text-muted">Markdown supported. Be respectful — no spam, scams or personal data.</p>
        </div>
      </form>
    </Modal>
  );
}
