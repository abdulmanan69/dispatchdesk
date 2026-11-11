import { BarChart, Bar, XAxis, YAxis, CartesianGrid, ReferenceLine } from 'recharts';
import { ChartBox, ThemedTooltip, useChartTheme, axisProps, PALETTE } from '../../components/dashboard/charts.jsx';
import { money, nf } from '../../lib/format.js';

const compact = (v) => nf({ style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(v);

/**
 * Reports "Gross and profit by month". One accent: profit in the brand color, gross as a neutral bar behind it.
 * Loaded lazily so recharts never delays the report's numbers.
 */
export default function ProfitChart({ rows, height = 280 }) {
  const t = useChartTheme();
  const data = rows.map((r) => ({ label: r.label, gross: r.grossCents / 100, profit: r.profitCents / 100 }));
  const gross = rows.reduce((s, r) => s + r.grossCents, 0);
  const profit = rows.reduce((s, r) => s + r.profitCents, 0);
  return (
    <ChartBox height={height} label={`Gross and estimated profit by month: ${money(gross, { digits: 0 })} gross, ${money(profit, { digits: 0 })} estimated profit`}>
      <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }} barGap={2} barCategoryGap="22%">
        <CartesianGrid stroke={t.line} vertical={false} />
        <XAxis dataKey="label" {...axisProps(t)} minTickGap={8} />
        <YAxis tickFormatter={compact} {...axisProps(t)} width={56} />
        <ReferenceLine y={0} stroke={t.line} />
        <ThemedTooltip formatter={(v, name) => [money(Math.round(v * 100), { digits: 0 }), name]} />
        <Bar dataKey="gross" name="Gross" fill={t.muted} fillOpacity={0.3} radius={[3, 3, 0, 0]} maxBarSize={36} isAnimationActive={false} />
        <Bar dataKey="profit" name="Est. profit" fill={PALETTE.brand} radius={[3, 3, 0, 0]} maxBarSize={36} isAnimationActive={false} />
      </BarChart>
    </ChartBox>
  );
}
