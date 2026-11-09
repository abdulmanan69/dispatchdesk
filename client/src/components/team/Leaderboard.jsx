import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Trophy } from 'lucide-react';
import { api } from '../../lib/api.js';
import { date, label } from '../../lib/format.js';
import { Card, Select, Tabs, Badge, QueryState, EmptyState, cx } from '../ui.jsx';

export const METRIC_COLS = [
  ['dials', 'Dials'], ['downloaded', 'Downloaded'], ['inTouch', 'In touch'], ['followUps', 'Follow-ups'],
  ['opportunities', 'Opps'], ['trials', 'Trials'], ['customers', 'Customers'],
];

export function MetricsTable({ rows, totals, showRank, highlightMe }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-[12px] text-muted">
            {showRank && <th className="w-10 px-3 py-2 font-medium">#</th>}
            <th className="px-3 py-2 font-medium">Dispatcher</th>
            {METRIC_COLS.map(([k, l]) => <th key={k} className="px-3 py-2 text-right font-medium">{l}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.userId} className={cx('border-b border-line/70 last:border-0', highlightMe && r.me && 'bg-brand-50/50 dark:bg-brand-900/20')}>
              {showRank && <td className="px-3 py-2 tabular text-muted">{r.rank === 1 ? <Trophy className="size-4 text-signal-500" aria-label="First place" /> : r.rank}</td>}
              <td className="px-3 py-2">
                <span className="font-medium">{r.name}</span>
                {r.role && <Badge className="ml-2">{label(r.role)}</Badge>}
              </td>
              {METRIC_COLS.map(([k]) => <td key={k} className="px-3 py-2 text-right tabular">{r[k]}</td>)}
            </tr>
          ))}
        </tbody>
        {totals && rows.length > 1 && (
          <tfoot>
            <tr className="border-t border-line font-medium">
              {showRank && <td />}
              <td className="px-3 py-2">Team total</td>
              {METRIC_COLS.map(([k]) => <td key={k} className="px-3 py-2 text-right tabular">{totals[k]}</td>)}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export default function Leaderboard({ hasTeam }) {
  const [mode, setMode] = useState(hasTeam ? 'team' : 'me');
  const [range, setRange] = useState('week');
  const q = useQuery({ queryKey: ['team', 'leaderboard', mode, range], queryFn: () => api.get('/api/teams/leaderboard', { mode, range }) });
  return (
    <Card title="Leaderboard" bodyClass="p-0"
      actions={<Select aria-label="Period" value={range} onChange={(e) => setRange(e.target.value)} className="w-36"><option value="week">Last 7 days</option><option value="month">Last 30 days</option></Select>}>
      {hasTeam && <div className="px-4 pt-1"><Tabs value={mode} onChange={setMode} tabs={[{ value: 'team', label: 'Team' }, { value: 'me', label: 'Just me' }]} /></div>}
      <QueryState query={q} isEmpty={(d) => !d.rows.length} empty={<EmptyState icon={Trophy} title="No activity yet" />}>
        {(d) => (
          <>
            <MetricsTable rows={d.rows} totals={d.totals} showRank={d.mode === 'team'} highlightMe />
            <p className="border-t border-line px-4 py-2 text-xs text-muted">Since {date(d.since)}. Ranked by weighted activity: customers and trials count most, then opportunities, conversations and dials.</p>
          </>
        )}
      </QueryState>
    </Card>
  );
}
