import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, Upload, Download, RefreshCw, Trash2, Pencil } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { bytes, date, label, toDateInput, DOCUMENT_TYPES } from '../../lib/format.js';
import { Badge, Button, EmptyState, ErrorState, Field, IconButton, Input, Loading, Select } from '../ui.jsx';
import { Modal, useConfirm } from '../Modal.jsx';
import { useToast } from '../Toast.jsx';

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.txt,.csv';

function expiryBadge(expiresAt) {
  if (!expiresAt) return null;
  const days = (new Date(expiresAt) - Date.now()) / 86400000;
  if (days < 0) return <Badge color="red">Expired {date(expiresAt)}</Badge>;
  if (days <= 30) return <Badge color="amber">Expires {date(expiresAt)}</Badge>;
  return <Badge color="gray">Expires {date(expiresAt)}</Badge>;
}

/**
 * Secure document list + upload for a carrier or a load.
 * Files are only ever served through the access-checked download endpoint.
 */
export default function DocumentsPanel({ carrierId, loadId, types, defaultType }) {
  const parent = carrierId ? { carrierId } : { loadId };
  const key = ['documents', parent];
  const q = useQuery({ queryKey: key, queryFn: () => api.get('/api/documents', { ...parent, types: types?.join(',') }), enabled: !!(carrierId || loadId) });
  const toast = useToast();
  const confirm = useConfirm();
  const fileRef = useRef(null);
  const replaceRef = useRef(null);
  const [type, setType] = useState(defaultType || types?.[0] || (loadId ? 'rate_confirmation' : 'agreement'));
  const [expiresAt, setExpiresAt] = useState('');
  const [replacing, setReplacing] = useState(null);
  const [editing, setEditing] = useState(null);
  const invalidate = [['documents'], ['customers'], ['customer'], ['loads']];

  const upload = useApiMutation((file) => {
    const fd = new FormData();
    Object.entries(parent).forEach(([k, v]) => fd.append(k, v));
    fd.append('type', type);
    if (expiresAt) fd.append('expiresAt', new Date(`${expiresAt}T12:00:00`).toISOString());
    fd.append('file', file);
    return api.upload('/api/documents', fd);
  }, { success: 'Document uploaded', invalidate, onSuccess: () => { setExpiresAt(''); if (fileRef.current) fileRef.current.value = ''; } });

  const replace = useApiMutation(({ id, file }) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.upload(`/api/documents/${id}`, fd, 'PUT');
  }, { success: 'Document replaced', invalidate, onSuccess: () => setReplacing(null) });

  const update = useApiMutation(({ id, ...body }) => api.patch(`/api/documents/${id}`, body), { success: 'Document updated', invalidate, onSuccess: () => setEditing(null) });
  const remove = useApiMutation((id) => api.del(`/api/documents/${id}`), { success: 'Document deleted', invalidate });

  const onPick = (e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); };
  const onReplace = (e) => { const f = e.target.files?.[0]; if (f && replacing) replace.mutate({ id: replacing, file: f }); e.target.value = ''; };
  const download = async (d) => {
    try { await api.download(`/api/documents/${d.id}/download`, d.originalName); } catch (err) { toast.error(err); }
  };
  const del = async (d) => {
    if (await confirm({ title: 'Delete document?', message: `"${d.originalName}" will be permanently removed.`, danger: true })) remove.mutate(d.id);
  };
  const typeOptions = types?.length ? types : DOCUMENT_TYPES;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 rounded-md border border-dashed border-line bg-surface-2/40 p-3 sm:flex-row sm:items-end">
        <Field label="Document type" className="sm:w-48">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            {typeOptions.map((t) => <option key={t} value={t}>{label(t)}</option>)}
          </Select>
        </Field>
        <Field label="Expires (optional)" className="sm:w-44">
          <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </Field>
        <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={onPick} aria-label="Choose document file" />
        <Button icon={Upload} loading={upload.isPending} onClick={() => fileRef.current?.click()}>Upload file</Button>
        <p className="text-xs text-muted sm:ml-auto sm:self-center">PDF, images, Word, Excel, CSV · max 15 MB</p>
      </div>
      <input ref={replaceRef} type="file" accept={ACCEPT} className="hidden" onChange={onReplace} aria-label="Choose replacement file" />

      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} /> : !q.data.items.length ? (
        <EmptyState icon={FileText} title="No documents yet">Upload agreements, MC authority, W-9, certificates of insurance, permits or load paperwork.</EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {q.data.items.map((d) => (
            <li key={d.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 items-start gap-2.5">
                <FileText className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0">
                  <button type="button" onClick={() => download(d)} className="block max-w-full truncate text-left text-sm font-medium hover:underline">{d.originalName}</button>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <Badge color="brand">{label(d.type)}</Badge>
                    {expiryBadge(d.expiresAt)}
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
                {DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
              </Select>
            </Field>
            <Field label="Expires" hint="Leave blank if the document does not expire.">
              <Input type="date" value={editing.expiresAt} onChange={(e) => setEditing({ ...editing, expiresAt: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
