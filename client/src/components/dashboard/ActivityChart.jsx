import { AreaChart, Area, Line, XAxis, YAxis, CartesianGrid } from 'recharts';
import { ChartBox, ThemedTooltip, useChartTheme, axisProps, shortDate, PALETTE } from './charts.jsx';

/** Dashboard "Calls and new leads" chart. Loaded lazily so recharts never delays the dashboard's numbers. */
export default function ActivityChart({ series, calls, leads, height = 300 }) {
  const t = useChartTheme();
  return (
    <ChartBox height={height} label={`Calls and new leads per day: ${calls} calls, ${leads} new leads`}>
      <AreaChart data={series} margin={{ left: -20, right: 8, top: 8 }}>
        <defs>
          <linearGradient id="gCalls" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={PALETTE.brand} stopOpacity={0.35} />
            <stop offset="100%" stopColor={PALETTE.brand} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={t.line} vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps(t)} minTickGap={24} />
        <YAxis allowDecimals={false} {...axisProps(t)} />
        <ThemedTooltip labelFormatter={shortDate} />
        <Line type="monotone" dataKey="leads" name="New leads" stroke={PALETTE.purple} strokeWidth={2} dot={false} />
        <Area type="monotone" dataKey="calls" name="Calls" stroke={PALETTE.brand} fill="url(#gCalls)" strokeWidth={2} activeDot={{ r: 3 }} />
      </AreaChart>
    </ChartBox>
  );
}
