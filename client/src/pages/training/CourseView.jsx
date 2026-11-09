import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, Clock, FileText, PlayCircle, Award, Video } from 'lucide-react';
import { api } from '../../lib/api.js';
import { label } from '../../lib/format.js';
import { Badge, Button, Card, PageHeader, QueryState } from '../../components/ui.jsx';
import { ProgressBar } from '../../components/training/ProgressBar.jsx';

export default function CourseView() {
  const { slug } = useParams();
  const q = useQuery({ queryKey: ['training', 'course', slug], queryFn: () => api.get(`/api/training/courses/${slug}`) });

  return (
    <QueryState query={q}>
      {({ course }) => {
        const p = course.progress;
        const started = p && p.completed > 0;
        return (
          <>
            <PageHeader
              breadcrumb={<Link to="/app/training" className="hover:underline">Training</Link>}
              title={course.title}
              subtitle={course.description}
              actions={course.nextLessonId && (
                <Button icon={PlayCircle} to={`/app/training/${slug}/${course.nextLessonId}`}>
                  {p?.complete ? 'Review course' : started ? 'Continue' : 'Start course'}
                </Button>
              )}
            />
            <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
              <Card title={`Lessons (${course.lessons.length})`} bodyClass="p-0">
                <ol>
                  {course.lessons.map((l, i) => (
                    <li key={l.id} className="border-b border-line/70 last:border-0">
                      <Link to={`/app/training/${slug}/${l.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2/60">
                        {l.completed
                          ? <CheckCircle2 className="size-5 shrink-0 text-green-600" aria-label="Completed" />
                          : <Circle className="size-5 shrink-0 text-muted/50" aria-label="Not completed" />}
                        <span className="w-6 shrink-0 text-xs tabular text-muted">{i + 1}.</span>
                        <span className="min-w-0 flex-1 text-sm font-medium">{l.title}</span>
                        <span className="hidden items-center gap-2 text-xs text-muted sm:flex">
                          {l.hasVideo && <Video className="size-3.5" aria-label="Video" />}
                          {l.hasAttachment && <FileText className="size-3.5" aria-label="Download" />}
                          <span className="inline-flex items-center gap-1"><Clock className="size-3.5" aria-hidden />{l.durationMinutes} min</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ol>
              </Card>
              <div className="space-y-4">
                <Card title="Your progress">
                  {p ? (
                    <>
                      <ProgressBar percent={p.percent} />
                      <p className="mt-2 text-sm text-muted">{p.completed} of {p.total} lessons completed</p>
                      {p.complete && (
                        <div className="mt-4 flex items-start gap-2.5 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">
                          <Award className="mt-0.5 size-4 shrink-0" aria-hidden />
                          <span>You completed every lesson in this course. Completion is recorded on your training dashboard.</span>
                        </div>
                      )}
                    </>
                  ) : <p className="text-sm text-muted">Sign in to track progress.</p>}
                </Card>
                <Card title="About this course">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge color="brand">{label(course.category)}</Badge>
                    <Badge>{label(course.level)}</Badge>
                    {!course.published && <Badge color="amber">Unpublished</Badge>}
                  </div>
                  <p className="mt-3 text-sm text-muted">{course.lessonCount} lessons · about {course.lessons.reduce((s, l) => s + l.durationMinutes, 0)} minutes</p>
                </Card>
              </div>
            </div>
          </>
        );
      }}
    </QueryState>
  );
}
