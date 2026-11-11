import { useEffect, useState } from 'react';

export const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Seconds since `since` (an ISO date), never negative. */
export const secondsSince = (since) => Math.max(0, (Date.now() - new Date(since).getTime()) / 1000);

/**
 * Live call timer. It owns its one-second interval so only this text re-renders while a call runs.
 * `seconds` (reported by the phone system) shows a fixed value; otherwise it counts from `since`.
 */
export default function CallTimer({ since, seconds, running = true, className = 'font-mono tabular text-fg' }) {
  const [, setTick] = useState(0);
  const live = seconds == null && !!since && running;
  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [live]);
  const value = seconds != null ? seconds : since ? secondsSince(since) : 0;
  return <span className={className}>{mmss(value)}</span>;
}
