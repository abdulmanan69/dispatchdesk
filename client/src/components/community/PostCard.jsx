import { Link } from 'react-router';
import { MessageSquare, Pin } from 'lucide-react';
import { Avatar, Badge } from '../ui.jsx';
import { label, relative } from '../../lib/format.js';

export function PostCard({ post, base }) {
  return (
    <article className="rounded-xl border border-line bg-surface p-4 transition-colors hover:border-brand-300/60">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
        {post.pinned && <Badge color="amber"><Pin className="size-3" aria-hidden />Pinned</Badge>}
        <Badge color="brand">{label(post.category)}</Badge>
        {post.status && post.status !== 'published' && <Badge color="red">{label(post.status)}</Badge>}
      </div>
      <h3 className="text-[15px] font-medium leading-snug">
        <Link to={`${base}/${post.id}`} className="hover:underline">{post.title}</Link>
      </h3>
      {post.excerpt && <p className="mt-1 line-clamp-2 text-sm text-muted">{post.excerpt}</p>}
      <div className="mt-3 flex items-center gap-2 text-xs text-muted">
        {post.author && (
          <Link to={`/u/${post.author.id}`} className="flex items-center gap-1.5 hover:text-fg">
            <Avatar name={post.author.name} src={post.author.avatarUrl} size={20} />
            <span className="font-medium">{post.author.name}</span>
          </Link>
        )}
        <span aria-hidden>·</span>
        <time dateTime={post.createdAt}>{relative(post.createdAt)}</time>
        <span className="ml-auto inline-flex items-center gap-1"><MessageSquare className="size-3.5" aria-hidden />{post.commentCount}<span className="sr-only"> comments</span></span>
      </div>
    </article>
  );
}

export const COMMUNITY_CATEGORIES = ['general', 'prospecting', 'brokers', 'loads', 'compliance', 'tools', 'wins'];
