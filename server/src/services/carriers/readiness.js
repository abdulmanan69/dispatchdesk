/**
 * New-authority kit: authority age milestones and the carrier readiness report, built only from public FMCSA data.
 *
 * Authority age is measured from the census add_date (the USDOT registration date). The MC grant date can be later,
 * so every label says "registered", and the report names its sources and when they were read.
 */

export const DAY_MS = 86400000;

/** Milestone windows for the prospect lists: registered in the last N days, or reaching 90 / 180 days within a week. */
export const MILESTONES = {
  new7: { label: 'Registered in the last 7 days', fromDays: 7, toDays: 0 },
  new30: { label: 'Registered in the last 30 days', fromDays: 30, toDays: 0 },
  new90: { label: 'Registered in the last 90 days', fromDays: 90, toDays: 0 },
  new180: { label: 'Registered in the last 180 days', fromDays: 180, toDays: 0 },
  turning90: { label: 'Reaching 90 days in the next 7 days', fromDays: 90, toDays: 83 },
  turning180: { label: 'Reaching 180 days in the next 7 days', fromDays: 180, toDays: 173 },
};
export const MILESTONE_KEYS = Object.keys(MILESTONES);

const startOfUtcDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** { addedAfter, addedBefore } census bounds for a milestone (whole UTC days, add_date is a date). */
export function milestoneRange(key, now = new Date()) {
  const m = MILESTONES[key] || MILESTONES.new30;
  const today = startOfUtcDay(now);
  return {
    addedAfter: new Date(today.getTime() - m.fromDays * DAY_MS),
    addedBefore: m.toDays ? new Date(today.getTime() - m.toDays * DAY_MS) : undefined,
  };
}

/** Whole days since the registration date (null when unknown). */
export function ageDays(date, now = new Date()) {
  if (!date) return null;
  const t = new Date(date).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((startOfUtcDay(now).getTime() - startOfUtcDay(new Date(t)).getTime()) / DAY_MS));
}

const addDays = (date, n) => new Date(new Date(date).getTime() + n * DAY_MS);

/**
 * Common broker minimums. Many brokers want 90 or 180 days of authority before they load a new carrier; this is a
 * typical industry practice, not a rule, so the report phrases it as such.
 */
export function brokerAcceptance(registeredAt, now = new Date()) {
  const age = ageDays(registeredAt, now);
  if (age == null) return { ageDays: null, reaches90At: null, reaches180At: null, note: 'Registration date unknown.' };
  const reaches90At = addDays(registeredAt, 90);
  const reaches180At = addDays(registeredAt, 180);
  let note;
  if (age < 90) note = `Registered ${age} day${age === 1 ? '' : 's'} ago. Brokers that ask for 90 days of authority become an option in ${90 - age} day${90 - age === 1 ? '' : 's'}; until then, look for brokers that load new authorities.`;
  else if (age < 180) note = `Registered ${age} days ago: past the common 90-day minimum. Brokers that ask for 180 days become an option in ${180 - age} day${180 - age === 1 ? '' : 's'}.`;
  else note = `Registered ${age} days ago: past the common 90- and 180-day broker minimums.`;
  return { ageDays: age, reaches90At, reaches180At, note };
}

const money = (n) => (n == null ? null : `$${Math.round(n).toLocaleString('en-US')}`);

/**
 * Readiness report for one census record, with optional QCMobile details (null when no webKey is set or the lookup
 * failed). Each check is pass | warn | fail | unknown with the source it came from.
 */
export function buildReadiness(record, qc, { now = new Date(), qcConfigured = false, qcError = null, censusRetrievedAt = now, qcRetrievedAt = null } = {}) {
  const extra = record._extra || {};
  const registeredAt = record.authorityDate || null;
  const acceptance = brokerAcceptance(registeredAt, now);
  const checks = [];
  const add = (key, label, status, detail, source) => checks.push({ key, label, status, detail, source });
  const CENSUS = 'FMCSA census';
  const QC = 'FMCSA QCMobile';
  const qcUnknown = qcConfigured ? (qcError ? `QCMobile lookup failed: ${qcError}` : 'Not found in QCMobile') : 'Add an FMCSA QCMobile webKey (Admin, Integrations) to check this';

  add('usdot', 'USDOT registration active', record.authorityStatus === 'active' ? 'pass' : record.authorityStatus === 'inactive' ? 'fail' : 'unknown',
    record.authorityStatus === 'active' ? 'Active in the census' : record.authorityStatus === 'inactive' ? 'Inactive in the census' : 'Status not reported', CENSUS);

  if (!record.mcNumber) add('docket', 'MC number', 'fail', 'No MC docket in the census (for-hire interstate carriers need one)', CENSUS);
  else {
    const ds = extra.docketStatus;
    add('docket', 'MC docket status', ds === 'active' ? 'pass' : ds === 'inactive' ? 'fail' : ds === 'pending' ? 'warn' : 'unknown',
      ds ? `MC ${record.mcNumber}: ${ds} in the census` : `MC ${record.mcNumber}: status not reported`, CENSUS);
  }

  if (qc?.authorityStatus) {
    add('authority', 'Operating authority (live)', qc.authorityStatus === 'active' ? 'pass' : qc.authorityStatus === 'pending' ? 'warn' : qc.authorityStatus === 'inactive' ? 'fail' : 'unknown',
      `Authority ${qc.authorityStatus}${qc.allowedToOperate === false ? ', not allowed to operate' : ''}`, QC);
  } else add('authority', 'Operating authority (live)', 'unknown', qcUnknown, QC);

  if (qc && qc.bipdOnFile != null) {
    const ok = qc.bipdOnFile > 0 && (qc.bipdRequired == null || qc.bipdOnFile >= qc.bipdRequired);
    add('bipd', 'Liability insurance (BIPD) on file', ok ? 'pass' : 'fail',
      `${money(qc.bipdOnFile)} on file${qc.bipdRequired ? `, ${money(qc.bipdRequired)} required` : ''}`, QC);
  } else add('bipd', 'Liability insurance (BIPD) on file', 'unknown', qc ? 'Not reported' : qcUnknown, QC);

  if (qc && qc.cargoOnFile != null) {
    add('cargo', 'Cargo insurance on file', qc.cargoOnFile > 0 ? 'pass' : 'warn',
      qc.cargoOnFile > 0 ? `${money(qc.cargoOnFile)} on file` : 'None on file with FMCSA (many brokers still ask for a cargo certificate)', QC);
  } else add('cargo', 'Cargo insurance on file', 'unknown', qc ? 'Not reported' : qcUnknown, QC);

  if (qc) add('oos', 'Out-of-service order', qc.outOfServiceDate ? 'fail' : 'pass', qc.outOfServiceDate ? `Out of service since ${qc.outOfServiceDate}` : 'None reported', QC);
  else add('oos', 'Out-of-service order', 'unknown', qcUnknown, QC);

  const age = acceptance.ageDays;
  const day = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(d);
  add('age', 'Authority age for broker setups', age == null ? 'unknown' : age >= 90 ? 'pass' : 'warn',
    age == null ? 'Registration date unknown'
      : age < 90 ? `${age} days; reaches 90 days on ${day(acceptance.reaches90At)}`
        : age < 180 ? `${age} days; reaches 180 days on ${day(acceptance.reaches180At)}`
          : `${age} days`, CENSUS);

  const contact = { phone: !!record.phone, email: !!record.email, address: !!(record.address && record.city && record.state) };
  const missing = Object.entries(contact).filter(([, v]) => !v).map(([k]) => k);
  add('contact', 'Contact details', missing.length === 0 ? 'pass' : missing.includes('phone') ? 'fail' : 'warn',
    missing.length ? `Missing: ${missing.join(', ')}` : 'Phone, email and address on file', CENSUS);

  const sources = [{ label: 'FMCSA Company Census (public)', retrievedAt: censusRetrievedAt, note: 'Registration date is the USDOT add date; the MC grant can be later.' }];
  sources.push(qcConfigured
    ? { label: 'FMCSA QCMobile', retrievedAt: qcRetrievedAt, note: qcError ? `Lookup failed: ${qcError}` : null }
    : { label: 'FMCSA QCMobile', retrievedAt: null, note: 'Not configured: insurance and live authority are unknown.' });

  return {
    carrier: {
      companyName: record.companyName, dbaName: record.dbaName, dotNumber: record.dotNumber, mcNumber: record.mcNumber,
      phone: record.phone, email: record.email, address: record.address, city: record.city, state: record.state,
      fleetSize: record.fleetSize, drivers: record.drivers, cargo: extra.cargo || [], hazmat: !!extra.hazmat,
    },
    authority: {
      registeredAt, ageDays: age, usdotStatus: record.authorityStatus || 'unknown', docketStatus: extra.docketStatus || null,
      live: qc?.authorityStatus || null, allowedToOperate: qc?.allowedToOperate ?? null,
    },
    insurance: qc ? { bipdOnFile: qc.bipdOnFile, bipdRequired: qc.bipdRequired, cargoOnFile: qc.cargoOnFile, bondOnFile: qc.bondOnFile } : null,
    insuranceStatus: !qc || qc.bipdOnFile == null ? 'unknown' : qc.bipdOnFile > 0 ? 'on_file' : 'missing',
    brokerAcceptance: acceptance,
    contact: { ...contact, missing, complete: missing.length === 0 },
    checks,
    summary: {
      pass: checks.filter((c) => c.status === 'pass').length,
      warn: checks.filter((c) => c.status === 'warn').length,
      fail: checks.filter((c) => c.status === 'fail').length,
      unknown: checks.filter((c) => c.status === 'unknown').length,
    },
    sources,
  };
}

/** Plain-text summary for a first-touch email (the user reviews and sends it from their own mailbox). */
export function readinessText(report) {
  const c = report.carrier;
  const lines = [
    `Authority snapshot for ${c.companyName}${c.mcNumber ? ` (MC ${c.mcNumber}` : ''}${c.dotNumber ? `${c.mcNumber ? ', ' : ' ('}USDOT ${c.dotNumber})` : c.mcNumber ? ')' : ''}`,
    '',
    // "Problem", not "Missing": a failed check can mean something is present (an out-of-service order).
    ...report.checks.map((k) => `- ${k.label}: ${{ pass: 'OK', warn: 'Check', fail: 'Problem', unknown: 'Unknown' }[k.status]}. ${k.detail}`),
    '',
    `Sources: ${report.sources.map((s) => s.label).join('; ')}. Registration date is the USDOT add date in the FMCSA census.`,
  ];
  return lines.join('\n');
}
