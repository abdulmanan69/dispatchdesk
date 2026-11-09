import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, MessageSquare, Store } from 'lucide-react';
import { api } from '../../lib/api.js';
import { date, label } from '../../lib/format.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Avatar, Badge, Card, EmptyState, QueryState } from '../../components/ui.jsx';
import { PostCard } from '../../components/community/PostCard.jsx';

export default function UserProfile() {
  const { userId } = useParams();
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['community', 'user', userId], queryFn: () => api.get(`/api/community/users/${userId}`) });
  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link to="/community" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="size-4" />Community</Link>
      <QueryState query={q}>
        {({ user: u, posts, listings }) => (
          <div className="grid gap-5 md:grid-cols-[260px_1fr]">
            <aside>
              <Card>
                <div className="flex flex-col items-center text-center">
                  <Avatar name={u.name} src={u.avatarUrl} size={72} />
                  <h1 className="mt-3 text-lg font-medium">{u.name}</h1>
                  <p className="text-xs text-muted">Member since {date(u.memberSince, { month: 'long', year: 'numeric' })}</p>
                  {u.bio && <p className="mt-3 whitespace-pre-wrap text-sm">{u.bio}</p>}
                  <div className="mt-4 flex gap-4 text-sm">
                    <span><strong className="tabular">{u.postCount}</strong> <span className="text-muted">posts</span></span>
                    <span><strong className="tabular">{u.commentCount}</strong> <span className="text-muted">comments</span></span>
                  </div>
                  {user?.id === u.id && <Link to="/app/settings" className="mt-4 text-xs text-brand-700 hover:underline dark:text-brand-300">Edit your profile</Link>}
                </div>
              </Card>
              {listings.length > 0 && (
                <Card title="Marketplace listings" className="mt-4" bodyClass="p-0">
                  <ul>
                    {listings.map((l) => (
                      <li key={l.id} className="border-b border-line/70 last:border-0">
                        <Link to={`/marketplace/${l.id}`} className="block px-4 py-2.5 hover:bg-surface-2">
                          <span className="block truncate text-sm font-medium">{l.title}</span>
                          <Badge className="mt-1">{label(l.category)}</Badge>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </aside>
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-medium"><MessageSquare className="size-4" aria-hidden />Recent posts</h2>
              {posts.length ? (
                <div className="space-y-3">{posts.map((p) => <PostCard key={p.id} post={p} base={user ? '/app/community' : '/community'} />)}</div>
              ) : <Card><EmptyState icon={listings.length ? Store : MessageSquare} title="No posts yet" /></Card>}
            </section>
          </div>
        )}
      </QueryState>
    </div>
  );
}
