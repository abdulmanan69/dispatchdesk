import { useEffect, useState } from 'react';
import { ResponsiveContainer, Tooltip } from 'recharts';

/**
 * Chart palette: each series gets its own hue from the app's categorical palette.
 * SERIES is the default order for multi-series charts.
 */
export const PALETTE = {
  brand: '#14b8a6', neutral: '#8b5cf6', signal: '#f59e0b', green: '#22c55e', red: '#ef4444',
  sky: '#3b82f6', indigo: '#8b5cf6', slate: '#64748b', blue: '#3b82f6', purple: '#8b5cf6', pink: '#ec4899', orange: '#f97316', teal: '#14b8a6', amber: '#f59e0b',
};
export const SERIES = ['#3b82f6', '#14b8a6', '#f59e0b', '#8b5cf6', '#ec4899', '#22c55e', '#f97316', '#ef4444'];

function readVars() {
  const s = getComputedStyle(document.documentElement);
  const v = (name, fb) => s.getPropertyValue(name).trim() || fb;
  const dark = document.documentElement.classList.contains('dark');
  // CSS color-mix() isn't understood by SVG attributes in every browser, so charts get solid hairline colors.
  return { muted: v('--muted', '#737373'), line: dark ? '#2a2a2d' : '#ececec', surface: v('--surface', '#fff'), fg: v('--fg', '#171717') };
}

/** Axis/grid colors that follow the active theme (re-read when the html class changes). */
export function useChartTheme() {
  const [t, setT] = useState(readVars);
  useEffect(() => {
    const mo = new MutationObserver(() => setT(readVars()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);
  return t;
}

export function axisProps(t) {
  return { tick: { fill: t.muted, fontSize: 11, fontFamily: 'IBM Plex Mono, ui-monospace, monospace' }, axisLine: false, tickLine: false };
}

export function ThemedTooltip(props) {
  const t = useChartTheme();
  return (
    <Tooltip
      cursor={{ fill: t.line, opacity: 0.35 }}
      contentStyle={{ background: t.surface, border: `1px solid ${t.line}`, borderRadius: 8, fontSize: 12, color: t.fg }}
      labelStyle={{ color: t.muted, marginBottom: 2 }}
      {...props}
    />
  );
}

export const shortDate = (k) => {
  const [, m, d] = String(k).split('-');
  return m && d ? `${Number(m)}/${Number(d)}` : k;
};

/** Fixed-height responsive chart wrapper with an accessible label. */
export function ChartBox({ height = 220, label, children }) {
  return (
    <div role="img" aria-label={label} style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
    </div>
  );
}

export function Legend({ items }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5"><span className="h-0.5 w-3 rounded-full" style={{ background: i.color }} />{i.label}</span>
      ))}
    </div>
  );
}
