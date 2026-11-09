import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, CheckCircle2, GraduationCap, MessageCircle, PlayCircle, Settings2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button, PageHeader, QueryState, StatCard, EmptyState, Card } from '../../components/ui.jsx';
import { CourseCard } from '../../components/training/CourseCard.jsx';
import { ProgressBar } from '../../components/training/ProgressBar.jsx';

export default function TrainingHome() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['training', 'dashboard'], queryFn: () => api.get('/api/training/me/dashboard') });

  return (
    <>
      <PageHeader
        title="Training"
        subtitle="Self-paced dispatch courses with progress tracking and trainer support."
        actions={<>
          {can('training.manage') && <Button variant="secondary" icon={Settings2} to="/app/admin/training">Manage training</Button>}
          <Button variant="secondary" icon={MessageCircle} to="/app/training/messages">Message a trainer</Button>
        </>}
      />
      <QueryState query={q}>
        {(d) => (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="Lessons completed" value={d.stats.lessonsCompleted} icon={CheckCircle2} />
              <StatCard label="Courses started" value={d.stats.coursesStarted} icon={BookOpen} />
              <StatCard label="Courses completed" value={`${d.stats.coursesCompleted} / ${d.stats.totalCourses}`} icon={GraduationCap} tone="green" />
              <StatCard label="Unread trainer replies" value={d.stats.unreadTrainerMessages} icon={MessageCircle} tone="signal" to="/app/training/messages" />
            </div>

            {d.continueCourse && (
              <Card title="Continue where you left off">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{d.continueCourse.title}</p>
                    {d.continueCourse.nextLesson && <p className="mt-0.5 truncate text-sm text-muted">Next: {d.continueCourse.nextLesson.title}</p>}
                    <ProgressBar percent={d.continueCourse.progress.percent} className="mt-2 max-w-md" />
                  </div>
                  {d.continueCourse.nextLesson && (
                    <Button icon={PlayCircle} to={`/app/training/${d.continueCourse.slug}/${d.continueCourse.nextLesson.id}`}>Resume lesson</Button>
                  )}
                </div>
              </Card>
            )}

            <section>
              <h2 className="mb-3 text-sm font-medium">All courses</h2>
              {d.courses.length ? (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {d.courses.map((c) => <CourseCard key={c.id} course={c} to={`/app/training/${c.slug}`} />)}
                </div>
              ) : (
                <EmptyState icon={GraduationCap} title="No courses published yet">
                  {can('training.manage') ? <>Create the first course in <Link className="underline" to="/app/admin/training">training management</Link>.</> : 'Check back soon.'}
                </EmptyState>
              )}
            </section>
          </div>
        )}
      </QueryState>
    </>
  );
}
