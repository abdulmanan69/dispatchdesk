import { cx } from '../ui.jsx';

export function ProgressBar({ percent = 0, className, label }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className={cx('flex items-center gap-2', className)}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={label || 'Progress'}>
        <div className={cx('h-full w-full origin-left rounded-full transition-ui duration-300', p === 100 ? 'bg-green-600' : 'bg-brand-600')} style={{ transform: `scaleX(${p / 100})` }} />
      </div>
      <span className="w-9 text-right text-xs tabular text-muted">{p}%</span>
    </div>
  );
}
