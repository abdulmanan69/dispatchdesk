import { stringify } from 'csv-stringify/sync';
import { safeCell } from '../../lib/csv.js';

/**
 * Profit report as CSV: one row per group, then the "others" row and a total row. csv-stringify quotes cells with
 * commas, quotes or line breaks; safeCell (lib/csv.js) keeps names such as =HYPERLINK(...) from running as formulas.
 */
const GROUP_HEADER = { carrier: 'Carrier', broker: 'Broker', lane: 'Lane', month: 'Month' };
export const PROFIT_COLUMNS = [
  'Loads', 'Gross', 'Linehaul', 'Detention', 'TONU', 'Dispatch fee', 'Fuel (estimated)', 'Other costs', 'Estimated profit',
  'Loaded miles', 'Total miles', 'Rate per mile', 'All-in rate per mile', 'Average gross per load', 'Average fee per load',
];

const dollars = (cents) => (cents == null ? '' : (cents / 100).toFixed(2));
const rate = (v) => (v == null ? '' : Number(v).toFixed(2));

function line(label, r) {
  return [
    label, r.loads, dollars(r.grossCents), dollars(r.rateCents), dollars(r.detentionCents), dollars(r.tonuCents), dollars(r.feeCents),
    dollars(r.fuelCents), dollars(r.otherCostsCents), dollars(r.profitCents), r.loadedMiles, r.totalMiles, rate(r.ratePerMile),
    rate(r.allInRatePerMile), dollars(r.avgGrossCents), dollars(r.avgFeeCents),
  ].map(safeCell);
}

export function profitCsv(report, groupBy) {
  const rows = [[GROUP_HEADER[groupBy] || 'Group', ...PROFIT_COLUMNS]];
  for (const r of report.rows) rows.push(line(r.label, r));
  if (report.others) rows.push(line(report.others.label, report.others));
  rows.push(line('Total', report.totals));
  // A byte-order mark so Excel opens the file as UTF-8 (lane arrows, accented company names).
  return `﻿${stringify(rows)}`;
}
