import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Eye, FileText, Pencil, Plus, Trash2, Upload, X, ExternalLink, GraduationCap, Inbox } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { dateTime, label, relative } from '../../lib/format.js';
import { useToast } from '../../components/Toast.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import {
  Avatar, Badge, Button, Card, DataTable, EmptyState, Field, IconButton, Input, Markdown, PageHeader, Pagination,
  QueryState, Select, Switch, Tabs, Textarea, cx,
} from '../../components/ui.jsx';
import { ChatThread } from '../../components/training/ChatThread.jsx';

const CATEGORIES = ['fundamentals', 'sales', 'operations', 'compliance', 'tools', 'business'];
const LEVELS = ['beginner', 'intermediate', 'advanced'];
const REQ_STATUSES = ['new', 'contacted', 'enrolled', 'closed'];
const ADMIN_KEY = ['training', 'admin'];

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------

function NewCourseModal({ open, onClose, onCreated }) {
  const [form, setForm] = useState({ title: '', category: 'fundamentals', level: 'beginner', description: '' });
  const create = useApiMutation((body) => api.post('/api/training/admin/courses', body), {
    invalidate: [ADMIN_KEY], success: 'Course created',
    onSuccess: (res) => { onCreated(res.course.id); setForm({ title: '', category: 'fundamentals', level: 'beginner', description: '' }); onClose(); },
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="New course"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="new-course" loading={create.isPending}>Create course</Button></>}>
      <form id="new-course" className="space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate(form); }}>
        <Field label="Title" required><Input value={form.title} onChange={set('title')} maxLength={160} required /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category"><Select value={form.category} onChange={set('category')}>{CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select></Field>
          <Field label="Level"><Select value={form.level} onChange={set('level')}>{LEVELS.map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select></Field>
        </div>
        <Field label="Description"><Textarea rows={3} value={form.description} onChange={set('description')} maxLength={2000} /></Field>
        <p className="text-xs text-muted">New courses start unpublished. Add lessons, then publish.</p>
      </form>
    </Modal>
  );
}

function LessonModal({ open, onClose, courseId, lesson }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [current, setCurrent] = useState(lesson);
  const [form, setForm] = useState({});
  const [preview, setPreview] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setCurrent(lesson);
    setPreview(false);
    setForm({ title: lesson?.title || '', durationMinutes: lesson?.durationMinutes ?? 10, videoUrl: lesson?.videoUrl || '', content: lesson?.content || '' });
  }, [open, lesson]);

  const refresh = () => qc.invalidateQueries({ queryKey: ADMIN_KEY });
  const save = useApiMutation(
    (body) => (current ? api.patch(`/api/training/admin/lessons/${current.id}`, body) : api.post(`/api/training/admin/courses/${courseId}/lessons`, body)),
    { invalidate: [ADMIN_KEY], success: current ? 'Lesson saved' : 'Lesson created — you can now attach a file', onSuccess: (res) => { if (current) onClose(); else setCurrent(res.lesson); } },
  );

  const upload = async (file) => {
    if (!file || !current) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.upload(`/api/training/admin/lessons/${current.id}/attachment`, fd);
      setCurrent(res.lesson);
      toast.success('Attachment uploaded');
      refresh();
    } catch (e) { toast.error(e); } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const removeAttachment = async () => {
    try { const res = await api.del(`/api/training/admin/lessons/${current.id}/attachment`); setCurrent(res.lesson); toast.success('Attachment removed'); refresh(); }
    catch (e) { toast.error(e); }
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <Modal open={open} onClose={onClose} size="lg" title={current ? 'Edit lesson' : 'New lesson'}
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button type="submit" form="lesson-form" loading={save.isPending}>{current ? 'Save lesson' : 'Create lesson'}</Button></>}>
      <form id="lesson-form" className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate({ ...form, durationMinutes: Number(form.durationMinutes) || 10 }); }}>
        <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
          <Field label="Title" required><Input value={form.title || ''} onChange={set('title')} maxLength={200} required /></Field>
          <Field label="Minutes"><Input type="number" min={1} max={600} value={form.durationMinutes ?? 10} onChange={set('durationMinutes')} /></Field>
        </div>
        <Field label="Video URL" hint="YouTube or Vimeo link. Leave empty for a text-only lesson.">
          <Input type="url" value={form.videoUrl || ''} onChange={set('videoUrl')} placeholder="https://www.youtube.com/watch?v=…" />
        </Field>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[13px] font-medium">Content (Markdown)</span>
            <Button variant="ghost" size="sm" icon={preview ? Pencil : Eye} onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</Button>
          </div>
          {preview
            ? <div className="min-h-48 rounded-md border border-line bg-bg p-3"><Markdown text={form.content || '*Nothing to preview*'} /></div>
            : <Textarea rows={14} value={form.content || ''} onChange={set('content')} className="font-mono text-[13px]" aria-label="Lesson content" />}
        </div>
      </form>
      <div className="mt-4 rounded-md border border-line p-3">
        <p className="mb-2 text-[13px] font-medium">Attachment</p>
        {!current ? (
          <p className="text-xs text-muted">Create the lesson first, then attach a PDF, slide deck, document or video file.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {current.attachmentName ? (
              <>
                <FileText className="size-4 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm">{current.attachmentName}</span>
                <Button variant="ghost" size="sm" icon={X} onClick={removeAttachment}>Remove</Button>
              </>
            ) : <span className="flex-1 text-sm text-muted">No file attached</span>}
            <input ref={fileRef} type="file" className="hidden" accept=".pdf,.docx,.pptx,.mp4,.webm,.png,.jpg,.txt" onChange={(e) => upload(e.target.files?.[0])} />
            <Button variant="secondary" size="sm" icon={Upload} loading={uploading} onClick={() => fileRef.current?.click()}>{current.attachmentName ? 'Replace' : 'Upload'}</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function CourseEditor({ courseId, onDeleted }) {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: [...ADMIN_KEY, 'course', courseId], queryFn: () => api.get(`/api/training/admin/courses/${courseId}`) });
  const [form, setForm] = useState(null);
  const [lessonModal, setLessonModal] = useState({ open: false, lesson: null });

  useEffect(() => {
    if (q.data) {
      const c = q.data.course;
      setForm({ title: c.title, slug: c.slug, description: c.description || '', category: c.category, level: c.level, sortOrder: c.sortOrder, published: c.published });
    }
  }, [q.data]);

  const save = useApiMutation((body) => api.patch(`/api/training/admin/courses/${courseId}`, body), { invalidate: [ADMIN_KEY, ['training']], success: 'Course saved' });
  const del = useApiMutation(() => api.del(`/api/training/admin/courses/${courseId}`), { invalidate: [ADMIN_KEY, ['training']], success: 'Course deleted', onSuccess: onDeleted });
  const delLesson = useApiMutation((id) => api.del(`/api/training/admin/lessons/${id}`), { invalidate: [ADMIN_KEY], success: 'Lesson deleted' });

  const move = async (index, dir) => {
    const lessons = [...q.data.course.lessons];
    const j = index + dir;
    if (j < 0 || j >= lessons.length) return;
    [lessons[index], lessons[j]] = [lessons[j], lessons[index]];
    try {
      await Promise.all(lessons.map((l, i) => (l.sortOrder !== i ? api.patch(`/api/training/admin/lessons/${l.id}`, { sortOrder: i }) : null)));
      qc.invalidateQueries({ queryKey: ADMIN_KEY });
    } catch (e) { toast.error(e); }
  };

  if (!form) return <QueryState query={q}>{() => null}</QueryState>;
  const course = q.data.course;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="space-y-4">
      <Card
        title={course.title}
        actions={<>
          {course.published && <Button variant="ghost" size="sm" icon={ExternalLink} to={`/app/training/${course.slug}`}>View</Button>}
          <IconButton icon={Trash2} label="Delete course" className="hover:text-red-600" onClick={async () => {
            if (await confirm({ title: 'Delete course?', message: `"${course.title}", its lessons, attachments and learner progress will be permanently deleted.`, danger: true })) del.mutate();
          }} />
        </>}
      >
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate({ ...form, sortOrder: Number(form.sortOrder) || 0 }); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Title" required><Input value={form.title} onChange={set('title')} required maxLength={160} /></Field>
            <Field label="URL slug" hint={`/app/training/${form.slug || '…'}`}><Input value={form.slug} onChange={set('slug')} maxLength={80} /></Field>
          </div>
          <Field label="Description"><Textarea rows={3} value={form.description} onChange={set('description')} maxLength={2000} /></Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Category"><Select value={form.category} onChange={set('category')}>{CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select></Field>
            <Field label="Level"><Select value={form.level} onChange={set('level')}>{LEVELS.map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select></Field>
            <Field label="Catalogue order"><Input type="number" min={0} value={form.sortOrder} onChange={set('sortOrder')} /></Field>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <Switch checked={form.published} onChange={(v) => setForm({ ...form, published: v })} label={form.published ? 'Published — visible to learners' : 'Draft — hidden from learners'} />
            <Button type="submit" loading={save.isPending}>Save course</Button>
          </div>
        </form>
      </Card>

      <Card title={`Lessons (${course.lessons.length})`} bodyClass="p-0"
        actions={<Button size="sm" icon={Plus} onClick={() => setLessonModal({ open: true, lesson: null })}>Add lesson</Button>}>
        {!course.lessons.length ? <EmptyState title="No lessons yet">Add the first lesson to this course.</EmptyState> : (
          <ol>
            {course.lessons.map((l, i) => (
              <li key={l.id} className="flex items-center gap-2 border-b border-line/70 px-3 py-2.5 last:border-0">
                <span className="w-6 text-xs tabular text-muted">{i + 1}.</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{l.title}</p>
                  <p className="text-xs text-muted">{l.durationMinutes} min{l.videoUrl ? ' · video' : ''}{l.attachmentName ? ` · ${l.attachmentName}` : ''}</p>
                </div>
                <IconButton icon={ArrowUp} label="Move up" disabled={i === 0} className="disabled:opacity-30" onClick={() => move(i, -1)} />
                <IconButton icon={ArrowDown} label="Move down" disabled={i === course.lessons.length - 1} className="disabled:opacity-30" onClick={() => move(i, 1)} />
                <IconButton icon={Pencil} label="Edit lesson" onClick={() => setLessonModal({ open: true, lesson: l })} />
                <IconButton icon={Trash2} label="Delete lesson" className="hover:text-red-600" onClick={async () => {
                  if (await confirm({ title: 'Delete lesson?', message: `"${l.title}" and its attachment will be deleted.`, danger: true })) delLesson.mutate(l.id);
                }} />
              </li>
            ))}
          </ol>
        )}
      </Card>
      <LessonModal open={lessonModal.open} lesson={lessonModal.lesson} courseId={courseId} onClose={() => setLessonModal({ open: false, lesson: null })} />
    </div>
  );
}

function CoursesTab() {
  const q = useQuery({ queryKey: [...ADMIN_KEY, 'courses'], queryFn: () => api.get('/api/training/admin/courses') });
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (!selected && q.data?.items?.length) setSelected(q.data.items[0].id); }, [q.data, selected]);

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <Card title="Courses" bodyClass="p-0" actions={<Button size="sm" icon={Plus} onClick={() => setCreating(true)}>New</Button>}>
        <QueryState query={q} isEmpty={(d) => !d.items.length} empty={<EmptyState icon={GraduationCap} title="No courses" />}>
          {(d) => (
            <ul className="max-h-[70vh] overflow-y-auto py-1">
              {d.items.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => setSelected(c.id)} aria-current={selected === c.id}
                    className={cx('block w-full px-3.5 py-2.5 text-left hover:bg-surface-2', selected === c.id && 'bg-brand-600/10')}>
                    <span className="block truncate text-sm font-medium">{c.title}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                      {c.published ? <Badge color="green">Published</Badge> : <Badge color="amber">Draft</Badge>}
                      {c.lessonCount} lessons
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Card>
      <div className="min-w-0">
        {selected ? <CourseEditor key={selected} courseId={selected} onDeleted={() => setSelected(null)} /> : <Card><EmptyState title="Select or create a course" /></Card>}
      </div>
      <NewCourseModal open={creating} onClose={() => setCreating(false)} onCreated={setSelected} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function RequestsTab() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: [...ADMIN_KEY, 'requests', status, page], queryFn: () => api.get('/api/training/admin/requests', { status, page, pageSize: 25 }) });
  const update = useApiMutation(({ id, status: s }) => api.patch(`/api/training/admin/requests/${id}`, { status: s }), { invalidate: [[...ADMIN_KEY, 'requests']], success: 'Status updated' });
  const counts = q.data?.counts || {};
  return (
    <Card bodyClass="p-0">
      <Tabs className="px-2" value={status} onChange={(v) => { setStatus(v); setPage(1); }}
        tabs={[{ value: '', label: 'All' }, ...REQ_STATUSES.map((s) => ({ value: s, label: label(s), count: counts[s] ?? 0 }))]} />
      <QueryState query={q} isEmpty={(d) => !d.items.length} empty={<EmptyState icon={Inbox} title="No training requests" />}>
        {(d) => (
          <>
            <DataTable
              rows={d.items}
              columns={[
                { key: 'name', header: 'Name', render: (r) => <span className="font-medium">{r.name}</span> },
                { key: 'email', header: 'Contact', render: (r) => <div className="text-xs"><a className="text-brand-700 hover:underline dark:text-brand-300" href={`mailto:${r.email}`}>{r.email}</a>{r.phone && <div className="text-muted">{r.phone}</div>}</div> },
                { key: 'message', header: 'Message', className: 'max-w-xs', render: (r) => <span className="line-clamp-2 text-xs text-muted">{r.message || '—'}</span> },
                { key: 'createdAt', header: 'Received', render: (r) => <span className="text-xs text-muted">{dateTime(r.createdAt)}</span> },
                { key: 'status', header: 'Status', render: (r) => (
                  <Select aria-label={`Status for ${r.name}`} className="h-8 w-32 text-xs" value={r.status} onChange={(e) => update.mutate({ id: r.id, status: e.target.value })}>
                    {REQ_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
                  </Select>
                ) },
              ]}
            />
            <div className="px-3"><Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} /></div>
          </>
        )}
      </QueryState>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Trainer inbox
// ---------------------------------------------------------------------------

function InboxTab({ userId, onSelect }) {
  const threads = useQuery({ queryKey: [...ADMIN_KEY, 'threads'], queryFn: () => api.get('/api/training/admin/threads'), refetchInterval: 30000 });
  const thread = useQuery({ queryKey: [...ADMIN_KEY, 'thread', userId], queryFn: () => api.get(`/api/training/admin/threads/${userId}`), enabled: !!userId });
  const reply = useApiMutation((body) => api.post(`/api/training/admin/threads/${userId}`, { body }), { invalidate: [[...ADMIN_KEY, 'thread', userId], [...ADMIN_KEY, 'threads']], success: 'Reply sent' });

  return (
    <div className="grid h-[min(72vh,680px)] gap-4 lg:grid-cols-[300px_1fr]">
      <Card title="Student threads" bodyClass="p-0 overflow-y-auto" className={cx('flex flex-col overflow-hidden', userId && 'hidden lg:flex')}>
        <QueryState query={threads} isEmpty={(d) => !d.items.length} empty={<EmptyState icon={Inbox} title="No messages yet" />}>
          {(d) => (
            <ul>
              {d.items.map((t) => (
                <li key={t.userId}>
                  <button type="button" onClick={() => onSelect(t.userId)} className={cx('flex w-full items-start gap-2.5 border-b border-line/60 px-3.5 py-3 text-left hover:bg-surface-2', userId === t.userId && 'bg-brand-600/10')}>
                    <Avatar name={t.name} src={t.avatarUrl} size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{t.name}</span>
                        {t.unread > 0 && <Badge color="amber">{t.unread} new</Badge>}
                      </div>
                      <p className="truncate text-xs text-muted">{t.lastFromTrainer ? 'You: ' : ''}{t.lastMessage}</p>
                      <p className="text-[11px] text-muted">{relative(t.lastAt)}</p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Card>
      <div className={cx('flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface', !userId && 'hidden lg:flex')}>
        {!userId ? <EmptyState title="Select a thread" /> : (
          <QueryState query={thread}>
            {(d) => (
              <>
                <header className="flex items-center gap-2 border-b border-line px-4 py-3">
                  <button type="button" className="text-sm text-muted lg:hidden" onClick={() => onSelect(null)}>Back</button>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{d.student.name}</p>
                    <p className="truncate text-xs text-muted">{d.student.email}</p>
                  </div>
                </header>
                <ChatThread messages={d.items} mine={(m) => m.fromTrainer} onSend={(body) => reply.mutateAsync(body)} sending={reply.isPending} placeholder="Reply as trainer… (Ctrl+Enter to send)" emptyText="No messages in this thread." />
              </>
            )}
          </QueryState>
        )}
      </div>
    </div>
  );
}

export default function TrainingAdmin() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'courses';
  const userId = params.get('user');
  const setTab = (t) => setParams({ tab: t });
  return (
    <>
      <PageHeader
        breadcrumb={<><Link to="/app/admin" className="hover:underline">Admin</Link> / Training</>}
        title="Training management"
        subtitle="Courses and lessons, training requests and the trainer inbox."
        actions={<Button variant="secondary" to="/app/training">Learner view</Button>}
      />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'courses', label: 'Courses' }, { value: 'requests', label: 'Requests' }, { value: 'inbox', label: 'Trainer inbox' }]} />
      {tab === 'courses' && <CoursesTab />}
      {tab === 'requests' && <RequestsTab />}
      {tab === 'inbox' && <InboxTab userId={userId} onSelect={(u) => setParams(u ? { tab: 'inbox', user: u } : { tab: 'inbox' })} />}
    </>
  );
}
