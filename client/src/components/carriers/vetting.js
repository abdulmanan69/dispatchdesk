/**
 * Carrier vetting checklist: one row per question a dispatcher asks before working with a carrier, each pass / warn /
 * fail / unknown with the reason, plus an overall verdict. Built from the FMCSA profile, the inspection report and
 * the related-carrier check (the last two load after the profile; until then their rows say "Checking").
 *
 * Only facts on the page feed it: every row points at the section that shows the evidence. There is no hidden score.
 */

export const LEVEL_RANK = { fail: 0, warn: 1, unknown: 2, pending: 3, pass: 4 };
const FLAG_LEVEL = { red: 'fail', amber: 'warn', green: 'pass', gray: 'unknown' };

const ROW_OF_FLAG = {
  usdot_inactive: 'authority', authority_inactive: 'authority', no_authority: 'authority', revocation_pending: 'authority',
  authority_pending: 'authority', authority_unknown: 'authority', new_authority: 'authority', revoked_before: 'authority',
  no_insurance: 'insurance', insurance_cancelling: 'insurance', insurance_lapse: 'insurance',
  not_allowed: 'safety', out_of_service: 'safety', rating_unsatisfactory: 'safety', rating_conditional: 'safety', basic_alert: 'safety',
  high_oos_driver: 'inspections', high_oos_vehicle: 'inspections', high_oos_hazmat: 'inspections',
  mcs150_outdated: 'identity', undeliverable: 'identity', prior_usdot_revoked: 'identity',
  oos_vehicle: 'inspections', oos_driver: 'inspections', oos_hazmat: 'inspections', fatal_crash: 'inspections', crashes: 'inspections', no_inspections: 'inspections',
  related_inactive: 'identity', related_active: 'identity',
};

export const ROWS = [
  { key: 'authority', label: 'Operating authority', anchor: 'authority' },
  { key: 'insurance', label: 'Insurance', anchor: 'insurance' },
  { key: 'safety', label: 'Safety rating', anchor: 'safety' },
  { key: 'inspections', label: 'Inspections and crashes', anchor: 'inspections' },
  { key: 'identity', label: 'Identity and contact', anchor: 'related' },
];

const usd = (n) => (n == null ? null : `$${Math.round(n).toLocaleString('en-US')}`);
const short = (d) => {
  if (!d) return '';
  const x = new Date(`${d}T00:00:00Z`);
  return Number.isNaN(x.getTime()) ? d : x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

/** The good-news text of a row when nothing is wrong with it. */
function passText(key, { p, ins, rel }) {
  const a = p.authority || {};
  if (key === 'authority') {
    if (a.status !== 'active') return null;
    return a.since ? `Active, granted ${short(a.since)}${a.ageYears >= 1 ? ` (${Math.floor(a.ageYears)} yr${Math.floor(a.ageYears) === 1 ? '' : 's'})` : ''}` : 'Active';
  }
  if (key === 'insurance') {
    const bipd = (p.insurance?.onFile || []).find((x) => x.category === 'bipd');
    if (bipd) return `BIPD ${usd(bipd.coverage) || 'on file'}${bipd.company ? ` · ${bipd.company}` : ''}`;
    return a.insuranceOnFile ? 'Liability insurance on file' : null;
  }
  if (key === 'safety') {
    if (!p.safety?.available) return null;
    return p.safety.rating === 'Satisfactory' ? 'Satisfactory rating' : 'Not rated (normal for most small carriers)';
  }
  if (key === 'inspections') {
    const s = ins?.summary;
    if (!s) return null;
    if (!s.inspections) return null;
    const parts = [];
    if (s.vehicle.oosRate != null) parts.push(`vehicle OOS ${s.vehicle.oosRate}% (avg ${s.vehicle.nationalAvg}%)`);
    if (s.driver.oosRate != null) parts.push(`driver OOS ${s.driver.oosRate}% (avg ${s.driver.nationalAvg}%)`);
    const crash = ins.crashes ? `, ${ins.crashes.total ? `${ins.crashes.total} crash${ins.crashes.total === 1 ? '' : 'es'}` : 'no crashes'}` : '';
    return parts.length ? `${s.inspections} inspections: ${parts.join(', ')}${crash}` : `${s.inspections} inspection${s.inspections === 1 ? '' : 's'}, too few for an out-of-service rate${crash}`;
  }
  if (key === 'identity') {
    if (!rel) return null;
    return rel.total ? `Shares contact details with ${rel.total} active carrier${rel.total === 1 ? '' : 's'}` : 'No other carrier shares its phone, email or address';
  }
  return null;
}

/**
 * { verdict: { level, label, reason }, rows: [{ key, label, anchor, level, text, items: [{ level, text }] }] }.
 * `inspections` / `related` are { data, isLoading, isError } shaped (react-query results) or null.
 */
export function vettingChecklist({ profile: p, inspections = null, related = null }) {
  const ins = inspections?.data || null;
  const rel = related?.data || null;
  const flags = [...(p.flags || [])];
  // The MCMIS inspection report replaces QCMobile's own OOS flags (same facts, newer data, all carriers).
  if (ins) flags.splice(0, flags.length, ...flags.filter((f) => !f.code.startsWith('high_oos_')), ...(ins.flags || []));
  if (rel) flags.push(...(rel.flags || []));
  const byRow = Object.fromEntries(ROWS.map((r) => [r.key, []]));
  for (const f of flags) {
    const row = ROW_OF_FLAG[f.code];
    if (!row) continue;
    const level = FLAG_LEVEL[f.level] || 'unknown';
    if (level === 'pass') continue; // green flags become the row's pass text
    if (f.code === 'related_active' || f.code === 'no_inspections') continue; // shown as plain row text below
    byRow[row].push({ level, text: f.text, code: f.code });
  }

  const rows = ROWS.map((r) => {
    const items = byRow[r.key].sort((x, y) => LEVEL_RANK[x.level] - LEVEL_RANK[y.level]);
    let level = items.length ? items[0].level : null;
    let text = items.length ? items[0].text : null;
    if (!level) {
      const loading = (r.key === 'inspections' && inspections?.isLoading) || (r.key === 'identity' && related?.isLoading);
      const failed = (r.key === 'inspections' && (inspections?.isError || !inspections)) || (r.key === 'identity' && (related?.isError || !related));
      const ok = passText(r.key, { p, ins, rel });
      if (ok) { level = 'pass'; text = ok; }
      else if (loading) { level = 'pending'; text = 'Checking…'; }
      else if (r.key === 'inspections' && ins?.summary?.inspections === 0) { level = 'unknown'; text = 'No roadside inspections in the last 24 months'; }
      else if (failed && (r.key === 'inspections' || r.key === 'identity')) { level = 'unknown'; text = 'Not available right now'; }
      else if (r.key === 'authority' && p.authority?.status === 'unknown') { level = 'unknown'; text = 'Could not be checked right now'; }
      else { level = 'unknown'; text = 'Not available right now'; }
    }
    return { ...r, level, text, items };
  });

  const fails = rows.filter((r) => r.level === 'fail');
  const warns = rows.filter((r) => r.level === 'warn');
  const verdict = fails.length
    ? { level: 'fail', label: 'Do not book', reason: fails[0].text }
    : warns.length
      ? { level: 'warn', label: 'Review before booking', reason: `${warns.length} thing${warns.length === 1 ? '' : 's'} to check: ${warns.map((w) => w.label.toLowerCase()).join(', ')}` }
      : rows.some((r) => r.level === 'pending')
        ? { level: 'pending', label: 'Checking', reason: 'Inspections and related carriers are loading' }
        : { level: 'pass', label: 'No red flags', reason: 'Authority, insurance, safety and contact checks found nothing to review' };
  return { verdict, rows };
}
