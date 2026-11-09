import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, EyeOff, Eye, MessageSquare, Pencil, Pin, PinOff, Reply, Trash2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { label, relative, dateTime } from '../../lib/format.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { Avatar, Badge, Button, Card, EmptyState, Markdown, QueryState, Textarea, cx } from '../../components/ui.jsx';
import { ReportButton } from '../../components/community/ReportModal.jsx';
import { PostEditor } from '../../components/community/PostEditor.jsx';

function CommentForm({ postId, parentId, onDone, autoFocus, placeholder = 'Add to the discussion…' }) {
  const [body, setBody] = useState('');
  const add = useApiMutation((b) => api.post(`/api/community/posts/${postId}/comments`, { body: b, parentId }), {
    invalidate: [['community', 'post', postId]], success: parentId ? 'Reply posted' : 'Comment posted',
    onSuccess: () => { setBody(''); onDone?.(); },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate(body.trim()); }} className="space-y-2">
      <Textarea rows={parentId ? 2 : 3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={8000} placeholder={placeholder} aria-label={parentId ? 'Reply' : 'Comment'} autoFocus={autoFocus} />
      <div className="flex justify-end gap-2">
        {onDone && <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>}
        <Button size="sm" type="submit" loading={add.isPending} disabled={!body.trim()}>{parentId ? 'Reply' : 'Comment'}</Button>
      </div>
    </form>
  );
}

function Comment({ c, postId, rootId, canModerate, nested }) {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.body);
  const inv = [['community', 'post', postId]];
  const save = useApiMutation((b) => api.patch(`/api/community/comments/${c.id}`, { body: b }), { invalidate: inv, success: 'Comment updated', onSuccess: () => setEditing(false) });
  const del = useApiMutation(() => api.del(`/api/community/comments/${c.id}`), { invalidate: inv, success: 'Comment deleted' });
  const moderate = useApiMutation(() => api.post(`/api/community/comments/${c.id}/moderate`, { status: 'removed' }), { invalidate: inv, success: 'Comment removed' });
  const gone = c.status !== 'published';

  return (
    <div id={`c-${c.id}`} className={cx('scroll-mt-20', nested && 'border-l-2 border-line pl-4')}>
      <div className="flex items-start gap-2.5">
        {c.author ? <Avatar name={c.author.name} src={c.author.avatarUrl} size={28} /> : <span className="size-7 shrink-0 rounded-full bg-surface-2" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            {c.author ? <Link to={`/u/${c.author.id}`} className="font-medium text-fg hover:underline">{c.author.name}</Link> : <span className="italic">removed</span>}
            {c.replyingTo && <span>replying to {c.replyingTo}</span>}
            <time dateTime={c.createdAt} title={dateTime(c.createdAt)}>{relative(c.createdAt)}</time>
            {c.edited && <span>(edited)</span>}
          </div>
          {editing ? (
            <form className="mt-1.5 space-y-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) save.mutate(text.trim()); }}>
              <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={8000} aria-label="Edit comment" />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setText(c.body); }}>Cancel</Button>
                <Button size="sm" type="submit" loading={save.isPending}>Save</Button>
              </div>
            </form>
          ) : (
            <div className={cx('mt-1', gone && 'italic text-muted')}>{gone ? <p className="text-sm">{c.body}</p> : <Markdown text={c.body} />}</div>
          )}
          {!gone && !editing && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {user && <Button size="sm" variant="ghost" icon={Reply} onClick={() => setReplying(!replying)}>Reply</Button>}
              {c.isOwner && <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>Edit</Button>}
              {(c.isOwner || canModerate) && (
                <Button size="sm" variant="ghost" icon={Trash2} onClick={async () => {
                  if (await confirm({ title: 'Delete comment?', message: 'This cannot be undone.', danger: true })) del.mutate();
                }}>Delete</Button>
              )}
              {canModerate && !c.isOwner && <Button size="sm" variant="ghost" icon={EyeOff} onClick={() => moderate.mutate()}>Remove</Button>}
              {user && !c.isOwner && <ReportButton url={`/api/community/comments/${c.id}/report`} what="comment" />}
            </div>
          )}
          {replying && (
            <div className="mt-2">
              <CommentForm postId={postId} parentId={c.id} autoFocus placeholder={`Reply to ${c.author?.name ?? 'comment'}…`} onDone={() => setReplying(false)} />
            </div>
          )}
          {!nested && c.replies?.length > 0 && (
            <div className="mt-3 space-y-4">
              {c.replies.map((r) => <Comment key={r.id} c={r} postId={postId} rootId={rootId} canModerate={canModerate} nested />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PostDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const isApp = location.pathname.startsWith('/app');
  const base = isApp ? '/app/community' : '/community';
  const [editing, setEditing] = useState(false);
  const q = useQuery({ queryKey: ['community', 'post', id, !!user], queryFn: () => api.get(`/api/community/posts/${id}`) });
  const inv = [['community']];

  useEffect(() => {
    if (q.data && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' });
  }, [q.data, location.hash]);

  const save = useApiMutation((b) => api.patch(`/api/community/posts/${id}`, b), { invalidate: inv, success: 'Post updated', onSuccess: () => setEditing(false) });
  const del = useApiMutation(() => api.del(`/api/community/posts/${id}`), { invalidate: inv, success: 'Post deleted', onSuccess: () => navigate(base) });
  const pin = useApiMutation((pinned) => api.post(`/api/community/posts/${id}/pin`, { pinned }), { invalidate: inv, success: (_, p) => (p ? 'Post pinned' : 'Post unpinned') });
  const moderate = useApiMutation((status) => api.post(`/api/community/posts/${id}/moderate`, { status }), { invalidate: inv, success: (_, s) => (s === 'published' ? 'Post restored' : `Post ${s}`) });

  const content = (
    <QueryState query={q}>
      {({ post, comments, canModerate }) => {
        const total = comments.reduce((s, c) => s + 1 + c.replies.length, 0);
        return (
          <>
            <article>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {post.pinned && <Badge color="amber"><Pin className="size-3" aria-hidden />Pinned</Badge>}
                <Badge color="brand">{label(post.category)}</Badge>
                {post.status !== 'published' && <Badge color="red">{label(post.status)}</Badge>}
              </div>
              <h1 className="text-2xl font-medium tracking-[-0.01em]">{post.title}</h1>
              <div className="mt-2 flex items-center gap-2 text-sm text-muted">
                {post.author && (
                  <Link to={`/u/${post.author.id}`} className="flex items-center gap-2 hover:text-fg">
                    <Avatar name={post.author.name} src={post.author.avatarUrl} size={24} /><span className="font-medium">{post.author.name}</span>
                  </Link>
                )}
                <span aria-hidden>·</span>
                <time dateTime={post.createdAt} title={dateTime(post.createdAt)}>{relative(post.createdAt)}</time>
                {post.edited && <span>(edited)</span>}
              </div>
              <Card className="mt-4"><Markdown text={post.body} className="text-[15px]" /></Card>
              <div className="mt-3 flex flex-wrap items-center gap-1">
                {post.isOwner && <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>Edit</Button>}
                {(post.isOwner || canModerate) && (
                  <Button size="sm" variant="ghost" icon={Trash2} onClick={async () => {
                    if (await confirm({ title: 'Delete post?', message: 'The post and all comments will be permanently deleted.', danger: true })) del.mutate();
                  }}>Delete</Button>
                )}
                {canModerate && (
                  <>
                    <Button size="sm" variant="ghost" icon={post.pinned ? PinOff : Pin} onClick={() => pin.mutate(!post.pinned)}>{post.pinned ? 'Unpin' : 'Pin'}</Button>
                    {post.status === 'published'
                      ? <Button size="sm" variant="ghost" icon={EyeOff} onClick={() => moderate.mutate('hidden')}>Hide</Button>
                      : <Button size="sm" variant="ghost" icon={Eye} onClick={() => moderate.mutate('published')}>Restore</Button>}
                  </>
                )}
                {!post.isOwner && <ReportButton url={`/api/community/posts/${post.id}/report`} what="post" />}
              </div>
            </article>

            <section className="mt-8" aria-labelledby="comments-heading">
              <h2 id="comments-heading" className="mb-4 flex items-center gap-2 text-sm font-medium"><MessageSquare className="size-4" aria-hidden />{total} {total === 1 ? 'comment' : 'comments'}</h2>
              {user ? (
                post.status === 'published' && <div className="mb-6"><CommentForm postId={post.id} /></div>
              ) : (
                <p className="mb-6 rounded-md border border-line bg-surface p-3 text-sm text-muted">
                  <Link to={`/login?next=${encodeURIComponent(location.pathname)}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">Log in</Link> to join the discussion.
                </p>
              )}
              {comments.length ? (
                <div className="space-y-5">{comments.map((c) => <Comment key={c.id} c={c} postId={post.id} rootId={c.id} canModerate={canModerate} />)}</div>
              ) : <EmptyState icon={MessageSquare} title="No comments yet">Share your experience or ask a follow-up question.</EmptyState>}
            </section>
            <PostEditor open={editing} onClose={() => setEditing(false)} initial={post} onSubmit={(b) => save.mutate(b)} busy={save.isPending} />
          </>
        );
      }}
    </QueryState>
  );

  return (
    <div className={isApp ? 'max-w-3xl' : 'mx-auto max-w-3xl px-4 py-8'}>
      <Link to={base} className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="size-4" />Community</Link>
      {content}
    </div>
  );
}
