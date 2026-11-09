import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CheckCircle2, Download, RotateCcw, Circle } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useToast } from '../../components/Toast.jsx';
import { Button, Card, Markdown, QueryState, cx } from '../../components/ui.jsx';

export default function LessonView() {
  const { slug, lessonId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const lessonQ = useQuery({ queryKey: ['training', 'lesson', lessonId], queryFn: () => api.get(`/api/training/lessons/${lessonId}`) });
  const courseQ = useQuery({ queryKey: ['training', 'course', slug], queryFn: () => api.get(`/api/training/courses/${slug}`) });
  const invalidate = [['training']];

  const complete = useApiMutation(() => api.post(`/api/training/lessons/${lessonId}/complete`), {
    invalidate,
    onSuccess: (res) => {
      if (res.courseComplete) toast.success('Course complete — nice work.');
      const next = lessonQ.data?.lesson.next;
      if (next && !res.courseComplete) navigate(`/app/training/${slug}/${next.id}`);
    },
  });
  const undo = useApiMutation(() => api.del(`/api/training/lessons/${lessonId}/complete`), { invalidate, success: 'Marked as not completed' });

  const download = async (l) => {
    try { await api.download(`/api/training/lessons/${l.id}/attachment`, l.attachmentName || 'attachment'); }
    catch (e) { toast.error(e); }
  };

  return (
    <QueryState query={lessonQ}>
      {({ lesson }) => (
        <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
          <article className="min-w-0">
            <div className="mb-1 text-[13px] text-muted">
              <Link to="/app/training" className="hover:underline">Training</Link> / <Link to={`/app/training/${slug}`} className="hover:underline">{lesson.course.title}</Link>
            </div>
            <h1 className="text-xl font-medium tracking-[-0.01em]">{lesson.title}</h1>
            <p className="mt-1 text-sm text-muted">Lesson {lesson.position} of {lesson.total} · {lesson.durationMinutes} min</p>

            {lesson.videoUrl && (
              <div className="mt-5 aspect-video overflow-hidden rounded-lg border border-line bg-black">
                <iframe src={lesson.videoUrl} title={`Video: ${lesson.title}`} className="size-full" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
              </div>
            )}

            <Card className="mt-5">
              {lesson.content ? <Markdown text={lesson.content} className="text-[15px]" /> : <p className="text-sm text-muted">This lesson has no written content.</p>}
            </Card>

            {lesson.hasAttachment && (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-3.5">
                <span className="min-w-0 truncate text-sm"><span className="text-muted">Download: </span>{lesson.attachmentName}</span>
                <Button size="sm" variant="secondary" icon={Download} onClick={() => download(lesson)}>Download</Button>
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-5">
              {lesson.prev ? <Button variant="secondary" icon={ArrowLeft} to={`/app/training/${slug}/${lesson.prev.id}`}>Previous</Button> : <span />}
              <div className="ml-auto flex flex-wrap gap-2">
                {lesson.completed ? (
                  <>
                    <Button variant="ghost" icon={RotateCcw} loading={undo.isPending} onClick={() => undo.mutate()}>Mark incomplete</Button>
                    {lesson.next && <Button icon={ArrowRight} to={`/app/training/${slug}/${lesson.next.id}`}>Next lesson</Button>}
                  </>
                ) : (
                  <Button icon={CheckCircle2} loading={complete.isPending} onClick={() => complete.mutate()}>
                    {lesson.next ? 'Complete & continue' : 'Complete lesson'}
                  </Button>
                )}
              </div>
            </div>
          </article>

          <aside className="lg:sticky lg:top-4 lg:self-start">
            <Card title="Course outline" bodyClass="p-0">
              {courseQ.data ? (
                <ol className="max-h-[70vh] overflow-y-auto py-1">
                  {courseQ.data.course.lessons.map((l, i) => (
                    <li key={l.id}>
                      <Link to={`/app/training/${slug}/${l.id}`} aria-current={l.id === lessonId ? 'page' : undefined}
                        className={cx('flex items-start gap-2 px-3.5 py-2 text-sm hover:bg-surface-2', l.id === lessonId && 'bg-brand-600/10 font-medium')}>
                        {l.completed ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-600" aria-label="Completed" /> : <Circle className="mt-0.5 size-4 shrink-0 text-muted/50" aria-hidden />}
                        <span><span className="tabular text-muted">{i + 1}. </span>{l.title}</span>
                      </Link>
                    </li>
                  ))}
                </ol>
              ) : <p className="p-4 text-sm text-muted">Loading outline…</p>}
            </Card>
          </aside>
        </div>
      )}
    </QueryState>
  );
}
