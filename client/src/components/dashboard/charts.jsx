import { ResponsiveContainer, Tooltip } from 'recharts';
import { useChartTheme } from './palette.jsx';

/**
 * recharts wrappers that follow the app theme. Colors, legends and axis helpers live in palette.jsx (no recharts)
 * and are re-exported here for existing imports.
 */
export { PALETTE, SERIES, useChartTheme, axisProps, shortDate, Legend } from './palette.jsx';

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

/** Fixed-height responsive chart wrapper with an accessible label. */
export function ChartBox({ height = 220, label, children }) {
  return (
    <div role="img" aria-label={label} style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
    </div>
  );
}
