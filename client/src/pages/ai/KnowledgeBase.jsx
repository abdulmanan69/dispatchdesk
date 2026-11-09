import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Upload, Trash2, RefreshCw, BookOpen, FileText } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useConfirm } from '../../components/Modal.jsx';
import { Badge, Button, Card, DataTable, EmptyState, Field, Input, PageHeader, QueryState, Select, Switch } from '../../components/ui.jsx';
import { relative } from '../../lib/format.js';

export default function KnowledgeBase() {
  const confirm = useConfirm();
  const fileRef = useRef(null);
  const [title, setTitle] = useState('');
  const [scope, setScope] = useState('private');
  const [file, setFile] = useState(null);
  const q = useQuery({ queryKey: ['ai', 'knowledge'], queryFn: () => api.get('/api/ai/knowledge') });
  const inv = [['ai', 'knowledge'], ['ai', 'status']];

  const upload = useApiMutation(() => {
    const fd = new FormData();
    fd.append('file', file);
    if (title) fd.append('title', title);
    fd.append('scope', scope);
    return api.upload('/api/ai/knowledge', fd);
  }, {
    invalidate: inv,
    success: (d) => (d.document.status === 'ready' ? `Indexed ${d.document.chunkCount} passages` : `Upload saved but processing failed: ${d.document.error}`),
    onSuccess: () => { setFile(null); setTitle(''); if (fileRef.current) fileRef.current.value = ''; },
  });
  const reprocess = useApiMutation((id) => api.post(`/api/ai/knowledge/${id}/reprocess`), { invalidate: inv, success: 'Reprocessed' });
  const approve = useApiMutation(({ id, approved }) => api.patch(`/api/ai/knowledge/${id}`, { approved }), { invalidate: inv, success: 'Updated' });
  const remove = useApiMutation((id) => api.del(`/api/ai/knowledge/${id}`), { invalidate: inv, success: 'Document deleted' });

  return (
    <div>
      <PageHeader title="Knowledge base" breadcrumb="AI dispatcher" subtitle="Documents the AI dispatcher can cite. Your private documents are only used in your own conversations." />
      <Card title="Add a document" className="mb-4">
        <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); if (file) upload.mutate(); }}>
          <Field label="File" hint="PDF, TXT, Markdown or CSV — up to 20 MB">
            <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.csv" onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm" />
          </Field>
          <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the file name" /></Field>
          {q.data?.canManageGlobal ? (
            <Field label="Visibility">
              <Select value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="private">Only me</option>
                <option value="global">Everyone (shared)</option>
              </Select>
            </Field>
          ) : <span />}
          <Button type="submit" icon={Upload} disabled={!file} loading={upload.isPending}>Upload &amp; index</Button>
        </form>
      </Card>
      <Card bodyClass="p-0">
        <QueryState query={q} isEmpty={(d) => !d.items.length}
          empty={<EmptyState icon={BookOpen} title="No documents yet">Upload SOPs, your carrier packet checklist, scripts or training notes. The AI cites them as sources.</EmptyState>}>
          {(d) => (
            <DataTable rows={d.items} columns={[
              { key: 'title', header: 'Document', render: (doc) => (
                <div className="flex items-center gap-2"><FileText className="size-4 text-muted" /><div><p className="font-medium">{doc.title}</p><p className="text-xs text-muted">{doc.originalName}</p></div></div>
              ) },
              { key: 'scope', header: 'Visibility', render: (doc) => doc.scope === 'global' ? <Badge color="brand">Shared{doc.approved ? '' : ' · hidden'}</Badge> : <Badge>Private</Badge> },
              { key: 'status', header: 'Status', render: (doc) => doc.status === 'ready' ? <Badge color="green">{doc.chunkCount} passages</Badge> : doc.status === 'error' ? <Badge color="red" className="max-w-56 truncate" title={doc.error}>Error: {doc.error}</Badge> : <Badge color="amber">Processing</Badge> },
              { key: 'owner', header: 'Added by', render: (doc) => <span className="text-muted">{doc.ownerName} · {relative(doc.createdAt)}</span> },
              { key: 'x', header: '', className: 'text-right', render: (doc) => (
                <div className="flex items-center justify-end gap-2">
                  {doc.scope === 'global' && d.canManageGlobal && <Switch checked={doc.approved} onChange={(v) => approve.mutate({ id: doc.id, approved: v })} label={<span className="text-xs">Visible</span>} />}
                  {doc.canDelete && <Button size="sm" variant="ghost" icon={RefreshCw} aria-label="Reprocess" loading={reprocess.isPending && reprocess.variables === doc.id} onClick={() => reprocess.mutate(doc.id)} />}
                  {doc.canDelete && <Button size="sm" variant="ghost" icon={Trash2} aria-label="Delete" onClick={async () => { if (await confirm({ title: `Delete "${doc.title}"?`, message: 'The file and its index are removed.', danger: true })) remove.mutate(doc.id); }} />}
                </div>
              ) },
            ]} />
          )}
        </QueryState>
      </Card>
    </div>
  );
}
