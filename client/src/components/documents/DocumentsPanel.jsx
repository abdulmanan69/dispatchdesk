import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Upload, Download, RefreshCw, Trash2, Pencil, X, Mail } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation, errorToast } from '../../lib/hooks.js';
import { bytes, date, label, toDateInput, DOCUMENT_TYPES } from '../../lib/format.js';
import { Badge, Button, EmptyState, ErrorState, Field, IconButton, Input, Loading, Select, cx } from '../ui.jsx';
import { Modal, useConfirm } from '../Modal.jsx';
import { useToast } from '../Toast.jsx';
import ComposeModal from '../email/ComposeModal.jsx';
import { DOC_LABEL, EXPIRING_TYPES, guessDocType } from './docTypes.js';

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.txt,.csv';
const MAX_FILES = 10;

function expiryBadge(expiresAt) {
  if (!expiresAt) return null;
  const days = (new Date(expiresAt) - Date.now()) / 86400000;
  if (days < 0) return <Badge color="red">Expired {date(expiresAt)}</Badge>;
  if (days <= 30) return <Badge color="amber">Expires {date(expiresAt)}</Badge>;
  return <Badge color="gray">Expires {date(expiresAt)}</Badge>;
}
const typeLabel = (t) => DOC_LABEL[t] || label(t);

/** Email text asking a carrier for missing paperwork (the user reviews and sends it from their own mailbox). */
export function documentRequestBody(types) {
  const list = (types?.length ? types : ['agreement', 'w9', 'coi', 'mc_authority']).map((t) => `- ${typeLabel(t)}`).join('\n');
  return `Hi {{first_name}},\n\nTo finish your file with us, please send the following:\n${list}\n\nA photo or PDF reply to this email is fine. Thank you.`;
}

/**
 * Secure document list + upload for a carrier or a load.
 * Pick or drop several files; each one's type is guessed from its name (unclear names stay "Other") and shown for
 * confirmation, with an expiry date where it applies, before anything uploads. Files are only ever served through
 * the access-checked download endpoint. `missing` (carrier) enables "Request documents" for those types.
 */
export default function DocumentsPanel({ carrierId, loadId, types, missing, carrierEmail }) {
  const parent = carrierId ? { carrierId } : { loadId };
  const key = ['documents', parent];
  const q = useQuery({ queryKey: key, queryFn: () => api.get('/api/documents', { ...parent, types: types?.join(',') }), enabled: !!(carrierId || loadId) });
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const fileRef = useRef(null);
  const replaceRef = useRef(null);
  const [pending, setPending] = useState([]); // [{ key, file, type, expiresAt }]
  const [uploading, setUploading] = useState(false);
  const [drag, setDrag] = useState(false);
  const [replacing, setReplacing] = useState(null);
  const [editing, setEditing] = useState(null);
  const [requesting, setRequesting] = useState(false);
  const invalidate = [['documents'], ['customers'], ['customer'], ['loads'], ['load']];
  const typeOptions = types?.length ? types : DOCUMENT_TYPES;

  const addFiles = (list) => {
    const files = [...(list || [])];
    if (!files.length) return;
    setPending((cur) => {
      const room = Math.max(0, MAX_FILES - cur.length);
      if (files.length > room) toast.info(`Up to ${MAX_FILES} files at a time`);
      return [...cur, ...files.slice(0, room).map((file) => ({ key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`, file, type: guessDocType(file.name, typeOptions), expiresAt: '' }))];
    });
    if (fileRef.current) fileRef.current.value = '';
  };

  const uploadAll = async () => {
    setUploading(true);
    let done = 0;
    const failed = [];
    for (const p of pending) {
      const fd = new FormData();
      Object.entries(parent).forEach(([k, v]) => fd.append(k, v));
      fd.append('type', p.type);
      if (p.expiresAt) fd.append('expiresAt', new Date(`${p.expiresAt}T12:00:00`).toISOString());
      fd.append('file', p.file);
      try {
        await api.upload('/api/documents', fd);
        done += 1;
      } catch (err) {
        failed.push(p);
        errorToast(toast, err);
      }
    }
    setPending(failed);
    setUploading(false);
    await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k })));
    if (done) toast.success(`${done} document${done === 1 ? '' : 's'} uploaded`);
  };

  const replace = useApiMutation(({ id, file }) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.upload(`/api/documents/${id}`, fd, 'PUT');
  }, { success: 'Document replaced', invalidate, onSuccess: () => setReplacing(null) });

  const update = useApiMutation(({ id, ...body }) => api.patch(`/api/documents/${id}`, body), { success: 'Document updated', invalidate, onSuccess: () => setEditing(null) });
  const remove = useApiMutation((id) => api.del(`/api/documents/${id}`), { success: 'Document deleted', invalidate });

  const onReplace = (e) => { const f = e.target.files?.[0]; if (f && replacing) replace.mutate({ id: replacing, file: f }); e.target.value = ''; };
  const download = async (d) => {
    try { await api.download(`/api/documents/${d.id}/download`, d.originalName); } catch (err) { toast.error(err); }
  };
  const del = async (d) => {
    if (await confirm({ title: 'Delete document?', message: `"${d.originalName}" will be permanently removed.`, danger: true })) remove.mutate(d.id);
  };
  const setRow = (k, patch) => setPending((cur) => cur.map((p) => (p.key === k ? { ...p, ...patch } : p)));

  return (
    <div className="space-y-4">
      <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer?.files); }}
        className={cx('space-y-3 rounded-md border border-dashed p-3 transition-ui', drag ? 'border-c-blue bg-c-blue-soft' : 'border-line bg-surface-2/40')}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input ref={fileRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => addFiles(e.target.files)} aria-label="Choose document files" />
          <Button icon={Upload} variant={pending.length ? 'secondary' : 'primary'} onClick={() => fileRef.current?.click()}>Choose files</Button>
          <p className="text-xs text-muted">or drop them here · PDF, images, Word, Excel, CSV · up to 15 MB each. You confirm each file’s type before it uploads.</p>
          {carrierId && (
            <Button variant="ghost" icon={Mail} className="sm:ml-auto" onClick={() => setRequesting(true)}>Request documents</Button>
          )}
        </div>
        {pending.length > 0 && (
          <div className="space-y-2">
            <ul className="divide-y divide-line rounded-md border border-line bg-surface">
              {pending.map((p) => (
                <li key={p.key} className="grid gap-2 px-3 py-2 sm:grid-cols-[1fr_190px_160px_auto] sm:items-end">
                  <div className="min-w-0 self-center">
                    <p className="truncate text-sm font-medium">{p.file.name}</p>
                    <p className="text-xs text-muted">{bytes(p.file.size)}</p>
                  </div>
                  <Field label="Type">
                    <Select value={p.type} onChange={(e) => setRow(p.key, { type: e.target.value })}>
                      {typeOptions.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
                    </Select>
                  </Field>
                  <Field label={EXPIRING_TYPES.includes(p.type) ? 'Expires' : 'Expires (optional)'}>
                    <Input type="date" value={p.expiresAt} onChange={(e) => setRow(p.key, { expiresAt: e.target.value })} />
                  </Field>
                  <IconButton icon={X} label={`Remove ${p.file.name}`} onClick={() => setPending((cur) => cur.filter((x) => x.key !== p.key))} className="justify-self-end" />
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button icon={Upload} loading={uploading} onClick={uploadAll}>Upload {pending.length} file{pending.length === 1 ? '' : 's'}</Button>
              <Button variant="ghost" disabled={uploading} onClick={() => setPending([])}>Clear</Button>
            </div>
          </div>
        )}
      </div>
      <input ref={replaceRef} type="file" accept={ACCEPT} className="hidden" onChange={onReplace} aria-label="Choose replacement file" />

      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} /> : !q.data.items.length ? (
        <EmptyState icon={FileText} title="No documents yet">{loadId ? 'Upload the rate con, BOL and POD for this load.' : 'Upload agreements, MC authority, W-9, certificates of insurance or permits.'}</EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {q.data.items.map((d) => (
            <li key={d.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 items-start gap-2.5">
                <FileText className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0">
                  <button type="button" onClick={() => download(d)} className="block max-w-full truncate text-left text-sm font-medium hover:underline">{d.originalName}</button>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <Badge color="brand">{typeLabel(d.type)}</Badge>
                    {expiryBadge(d.expiresAt)}
                    {d.source && d.source !== 'upload' && <Badge color="gray">{d.source === 'driver_link' ? 'From driver' : d.source === 'onboarding' ? 'From carrier' : d.source === 'generated' ? 'Made in DispatchDesk' : label(d.source)}</Badge>}
                    <span>{bytes(d.sizeBytes)} · {date(d.createdAt)}{d.uploadedBy ? ` · ${d.uploadedBy.name}` : ''}</span>
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 gap-0.5 self-end sm:self-auto">
                <IconButton icon={Download} label="Download" onClick={() => download(d)} />
                <IconButton icon={Pencil} label="Edit type or expiry" onClick={() => setEditing({ id: d.id, type: d.type, expiresAt: toDateInput(d.expiresAt) })} />
                <IconButton icon={RefreshCw} label="Replace file" onClick={() => { setReplacing(d.id); replaceRef.current?.click(); }} disabled={replace.isPending} />
                <IconButton icon={Trash2} label="Delete" onClick={() => del(d)} className="hover:text-red-600" />
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} title="Edit document" size="sm"
        footer={<>
          <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
          <Button loading={update.isPending} onClick={() => update.mutate({ id: editing.id, type: editing.type, expiresAt: editing.expiresAt ? new Date(`${editing.expiresAt}T12:00:00`).toISOString() : null })}>Save</Button>
        </>}>
        {editing && (
          <div className="space-y-3">
            <Field label="Type">
              <Select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value })}>
                {DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
              </Select>
            </Field>
            <Field label="Expires" hint="Leave blank if the document does not expire.">
              <Input type="date" value={editing.expiresAt} onChange={(e) => setEditing({ ...editing, expiresAt: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>
      {carrierId && (
        <ComposeModal open={requesting} onClose={() => setRequesting(false)} carrierId={carrierId} toEmail={carrierEmail || ''} templateCategory="carrier"
          subject="Documents we need for your file" body={documentRequestBody(missing)} />
      )}
    </div>
  );
}
