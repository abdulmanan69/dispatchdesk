import { Router } from 'express';
import { ah } from '../lib/errors.js';
import { parse, z, optBool } from '../lib/validate.js';
import { canViewTeam, readableOwnerIds } from '../lib/access.js';
import { DEFAULT_TZ } from '../lib/timezones.js';
import { requirePermission, refuseApiToken } from '../middleware/auth.js';
import { RANGE_PRESETS, resolveRange, monthComparison } from '../services/reports/range.js';
import { GROUP_BYS, profitReport, profitSummary } from '../services/reports/profit.js';
import { brokerPaymentsReport } from '../services/reports/payments.js';
import { profitCsv } from '../services/reports/csv.js';
import { cachedReport } from '../services/reports/cache.js';

/**
 * Profit reports and broker payment history (/api/reports). Every query is limited to the owners the user may read
 * (their own, or the team's with scope=team and team rights) and aggregated in SQL; see services/reports.
 *
 *   GET /profit?groupBy=carrier|broker|lane|month&range=this_month|last_month|last_90|this_year|custom&from&to&scope&inTransit
 *   GET /profit.csv        the same report as a CSV file
 *   GET /summary           KPI tiles: this month against last month
 *   GET /brokers/payments  per broker: invoices, days to pay, paid late, open and past-due balance
 */
const r = Router();
r.use(requirePermission('crm.use'));

const day = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use dates as YYYY-MM-DD').optional();
const scope = z.enum(['mine', 'team']).default('mine');
const profitQuery = z.object({
  groupBy: z.enum(GROUP_BYS).default('carrier'),
  range: z.enum(RANGE_PRESETS).optional(),
  from: day,
  to: day,
  scope,
  inTransit: optBool,
});

/** Effective scope (team only with team rights), the owner ids it covers and the user's time zone. */
async function contextOf(req, wanted) {
  const s = wanted === 'team' && canViewTeam(req.user) ? 'team' : 'mine';
  return { scope: s, ownerIds: await readableOwnerIds(req.user, s), tz: req.user.timezone || DEFAULT_TZ, canViewTeam: canViewTeam(req.user) };
}

async function profitFor(req) {
  const q = parse(profitQuery, req.query);
  const ctx = await contextOf(req, q.scope);
  const range = resolveRange(ctx.tz, q);
  const inTransit = !!q.inTransit;
  const report = await cachedReport(req, ['profit', q.groupBy, ctx.scope, range.from, range.to, inTransit],
    () => profitReport({ ownerIds: ctx.ownerIds, range, groupBy: q.groupBy, inTransit }));
  return {
    groupBy: q.groupBy,
    scope: ctx.scope,
    canViewTeam: ctx.canViewTeam,
    inTransit,
    range: { key: range.key, from: range.from, to: range.to, timezone: range.timezone },
    ...report,
  };
}

r.get('/profit', ah(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(await profitFor(req));
}));

r.get('/profit.csv', ah(async (req, res) => {
  refuseApiToken(req, 'export reports');
  const report = await profitFor(req);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', `attachment; filename="profit-by-${report.groupBy}-${report.range.from}-to-${report.range.to}.csv"`);
  res.send(profitCsv(report, report.groupBy));
}));

r.get('/summary', ah(async (req, res) => {
  const q = parse(z.object({ scope, inTransit: optBool }), req.query);
  const ctx = await contextOf(req, q.scope);
  const months = monthComparison(ctx.tz);
  const inTransit = !!q.inTransit;
  const summary = await cachedReport(req, ['summary', ctx.scope, months.today, inTransit],
    () => profitSummary({ ownerIds: ctx.ownerIds, months, inTransit }));
  res.set('Cache-Control', 'private, no-store');
  res.json({ scope: ctx.scope, canViewTeam: ctx.canViewTeam, timezone: ctx.tz, today: months.today, inTransit, ...summary });
}));

r.get('/brokers/payments', ah(async (req, res) => {
  const q = parse(z.object({ scope }), req.query);
  const ctx = await contextOf(req, q.scope);
  const report = await cachedReport(req, ['payments', ctx.scope], () => brokerPaymentsReport(ctx.ownerIds));
  res.set('Cache-Control', 'private, no-store');
  res.json({ scope: ctx.scope, canViewTeam: ctx.canViewTeam, basis: 'own_invoices', ...report });
}));

export default r;
