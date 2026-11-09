import { Link } from 'react-router';
import { BookOpen, Clock, CheckCircle2 } from 'lucide-react';
import { Badge } from '../ui.jsx';
import { label } from '../../lib/format.js';
import { ProgressBar } from './ProgressBar.jsx';

export function CourseCard({ course, to }) {
  const p = course.progress;
  return (
    <Link to={to} className="flex flex-col rounded-xl border border-line bg-surface p-4 transition-colors hover:border-brand-300/70">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Badge color="brand">{label(course.category)}</Badge>
        <Badge>{label(course.level)}</Badge>
        {p?.complete && <Badge color="green"><CheckCircle2 className="size-3" aria-hidden />Completed</Badge>}
      </div>
      <h3 className="font-medium leading-snug">{course.title}</h3>
      {course.description && <p className="mt-1 line-clamp-3 text-sm text-muted">{course.description}</p>}
      <div className="mt-auto flex items-center gap-3 pt-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1"><BookOpen className="size-3.5" aria-hidden />{course.lessonCount} lessons</span>
        {course.totalMinutes != null && <span className="inline-flex items-center gap-1"><Clock className="size-3.5" aria-hidden />{course.totalMinutes} min</span>}
      </div>
      {p && <ProgressBar percent={p.percent} className="mt-3" label={`${course.title} progress`} />}
    </Link>
  );
}
