/**
 * Fake FMCSA licensing datasets for setFmcsaFetch(), so tests never reach FMCSA:
 *   - legacy Licensing & Insurance (6eyk-hxee): `docket_number in('MC…')` answers from `rows` (MC -> row fields;
 *     null = no record); any other MC answers with `fallback` (active authority, insurance on file; null = no record).
 *     `dot_number in('00…')` answers from `byDot` (USDOT -> array of rows).
 *   - Motus (inys-ebih): `docket_number in(…)` answers from `motus` (MC -> row or array of rows; none by default) and
 *     `usdot_number in(…)` from `motusByDot` (USDOT -> array of rows).
 * `fake.down` fails both datasets, `fake.legacyDown` / `fake.motusDown` one of them. `fake.calls` lists the MC
 * dockets of each legacy request, `fake.motusCalls` those of each Motus request.
 * Lead-signal datasets (answered with no rows unless set; `fake.signalsDown` fails them all):
 *   - Motus / legacy authority history (yu5v-wbh6 / 9mw4-x3tu): `motusHistory` / `history` (MC -> array of rows).
 *   - Motus / legacy insurance (c5y8-a4uz / qh9u-swkp): `motusInsurance` / `insurance` (MC -> array of rows).
 *   - Census count(*) grouped by phone or email (az4n-8mr2 with $group): `sharedPhones` / `sharedEmails`
 *     (value -> count). `fake.signalCalls` lists { dataset, values } for each of these requests (values = the in() list).
 *   - QCMobile carriers/{dot} (needs the fmcsa.webKey setting): `qc` (USDOT -> carrier record; missing = 404).
 *     `fake.qcCalls` lists the USDOT numbers asked, `fake.qcPeak` the most QCMobile calls in flight at once.
 */
export const ACTIVE_ROW = Object.freeze({
  common_stat: 'A', contract_stat: 'N', broker_stat: 'N', common_app_pend: 'N', contract_app_pend: 'N', broker_app_pend: 'N',
  common_rev_pend: 'N', contract_rev_pend: 'N', broker_rev_pend: 'N', bipd_req: 'Y', bipd_file: '00750', cargo_req: 'N', bond_req: 'N', bond_file: 'N',
  undeliverable_mail: 'Y',
});
export const INACTIVE_ROW = Object.freeze({ ...ACTIVE_ROW, common_stat: 'N', contract_stat: 'I', bipd_file: '00000', undeliverable_mail: 'N' });
export const PENDING_ROW = Object.freeze({ ...ACTIVE_ROW, common_stat: 'N', common_app_pend: 'Y', bipd_file: '00000' });

export const MOTUS_PROPERTY = 'Motor Carrier of Property (Except Household Goods)';
/** A Motus authority row (op_auth_status Active | Pending | Inactive | Withdrawn, bipd_file in dollars as decimal text). */
export const motusRow = (status = 'Active', extra = {}) => ({
  op_auth_type: MOTUS_PROPERTY, op_auth_status: status, min_cov_amount: '750000.000000000000000000',
  bipd_file: status === 'Active' ? '750000.000000000000000000' : '0.000000000000000000', bus_undeliverable_mail: 'Y', mail_undeliverable_mail: 'Y', ...extra,
});

const list = (where, field) => {
  const m = new RegExp(`(?:^|[^a-z_])${field} in\\(([^)]*)\\)`).exec(where);
  return m ? m[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean) : [];
};
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function licensingFake({
  rows = {}, fallback = ACTIVE_ROW, byDot = {}, motus = {}, motusByDot = {}, motusHistory = {}, history = {}, motusInsurance = {}, insurance = {},
  sharedPhones = {}, sharedEmails = {}, qc = {},
} = {}) {
  const fake = {
    motusHistory: { ...motusHistory },
    history: { ...history },
    motusInsurance: { ...motusInsurance },
    insurance: { ...insurance },
    sharedPhones: { ...sharedPhones },
    sharedEmails: { ...sharedEmails },
    signalsDown: false,
    signalCalls: [],
    qc: { ...qc },
    qcCalls: [],
    qcPeak: 0,
    qcInFlight: 0,
    rows: { ...rows },
    fallback,
    byDot: { ...byDot },
    motus: { ...motus },
    motusByDot: { ...motusByDot },
    down: false,
    legacyDown: false,
    motusDown: false,
    calls: [],
    motusCalls: [],
    fetch: async (url) => {
      const u = new URL(String(url));
      if (u.host === 'mobile.fmcsa.dot.gov') {
        const dot = /\/carriers\/(\d+)$/.exec(u.pathname)?.[1];
        fake.qcCalls.push(dot);
        fake.qcInFlight++;
        fake.qcPeak = Math.max(fake.qcPeak, fake.qcInFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        fake.qcInFlight--;
        const carrier = fake.qc[dot];
        return carrier ? { ok: true, status: 200, json: async () => ({ content: { carrier } }) } : { ok: false, status: 404, json: async () => ({}) };
      }
      const where = u.searchParams.get('$where') || '';
      const dockets = list(where, 'docket_number');
      const ok = (body) => ({ ok: true, status: 200, json: async () => body });
      const byDocket = (dataset, map) => {
        fake.signalCalls.push({ dataset, values: dockets });
        if (fake.signalsDown) throw new Error(`${dataset} timeout`);
        return ok(dockets.flatMap((d) => asArray(map[d.slice(2)]).map((r) => ({ docket_number: d, ...r }))));
      };
      if (u.pathname.includes('yu5v-wbh6')) return byDocket('motusHistory', fake.motusHistory);
      if (u.pathname.includes('9mw4-x3tu')) return byDocket('history', fake.history);
      if (u.pathname.includes('c5y8-a4uz')) return byDocket('motusInsurance', fake.motusInsurance);
      if (u.pathname.includes('qh9u-swkp')) return byDocket('insurance', fake.insurance);
      if (u.pathname.includes('az4n-8mr2') && u.searchParams.get('$group')) {
        const email = /email/.test(u.searchParams.get('$group'));
        const values = /in\(([^)]*)\)/.exec(where)?.[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')) || [];
        fake.signalCalls.push({ dataset: email ? 'sharedEmails' : 'sharedPhones', values });
        if (fake.signalsDown) throw new Error('census timeout');
        const map = email ? fake.sharedEmails : fake.sharedPhones;
        return ok(values.filter((v) => map[v]).map((v) => ({ v, n: String(map[v]) })));
      }
      if (u.pathname.includes('6eyk-hxee')) {
        fake.calls.push(dockets);
        if (fake.down || fake.legacyDown) throw new Error('licensing dataset timeout');
        const out = dockets.flatMap((d) => {
          const mc = d.slice(2);
          const row = Object.hasOwn(fake.rows, mc) ? fake.rows[mc] : fake.fallback;
          return row ? [{ docket_number: d, ...row }] : [];
        });
        for (const dot of list(where, 'dot_number')) out.push(...asArray(fake.byDot[dot.replace(/^0+/, '')]).map((r) => ({ dot_number: dot, ...r })));
        return ok(out);
      }
      if (u.pathname.includes('inys-ebih')) {
        fake.motusCalls.push(dockets);
        if (fake.down || fake.motusDown) throw new Error('Motus dataset timeout');
        const out = dockets.flatMap((d) => asArray(fake.motus[d.slice(2)]).map((r) => ({ docket_number: d, ...r })));
        for (const dot of list(where, 'usdot_number')) out.push(...asArray(fake.motusByDot[dot]).map((r) => ({ usdot_number: dot, ...r })));
        return ok(out);
      }
      throw new Error(`unexpected FMCSA request in a test: ${u.host}${u.pathname}`);
    },
  };
  return fake;
}
