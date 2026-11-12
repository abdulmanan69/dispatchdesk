/**
 * Fake FMCSA licensing datasets for setFmcsaFetch(), so tests never reach FMCSA:
 *   - legacy Licensing & Insurance (6eyk-hxee): `docket_number in('MC…')` answers from `rows` (MC -> row fields;
 *     null = no record); any other MC answers with `fallback` (active authority, insurance on file; null = no record).
 *     `dot_number in('00…')` answers from `byDot` (USDOT -> array of rows).
 *   - Motus (inys-ebih): `docket_number in(…)` answers from `motus` (MC -> row or array of rows; none by default) and
 *     `usdot_number in(…)` from `motusByDot` (USDOT -> array of rows).
 * `fake.down` fails both datasets, `fake.legacyDown` / `fake.motusDown` one of them. `fake.calls` lists the MC
 * dockets of each legacy request, `fake.motusCalls` those of each Motus request.
 */
export const ACTIVE_ROW = Object.freeze({
  common_stat: 'A', contract_stat: 'N', broker_stat: 'N', common_app_pend: 'N', contract_app_pend: 'N', broker_app_pend: 'N',
  common_rev_pend: 'N', contract_rev_pend: 'N', broker_rev_pend: 'N', bipd_req: 'Y', bipd_file: '00750', cargo_req: 'N', bond_req: 'N', bond_file: 'N',
  undeliverable_mail: 'N',
});
export const INACTIVE_ROW = Object.freeze({ ...ACTIVE_ROW, common_stat: 'N', contract_stat: 'I', bipd_file: '00000', undeliverable_mail: 'Y' });
export const PENDING_ROW = Object.freeze({ ...ACTIVE_ROW, common_stat: 'N', common_app_pend: 'Y', bipd_file: '00000' });

export const MOTUS_PROPERTY = 'Motor Carrier of Property (Except Household Goods)';
/** A Motus authority row (op_auth_status Active | Pending | Inactive | Withdrawn, bipd_file in dollars as decimal text). */
export const motusRow = (status = 'Active', extra = {}) => ({
  op_auth_type: MOTUS_PROPERTY, op_auth_status: status, min_cov_amount: '750000.000000000000000000',
  bipd_file: status === 'Active' ? '750000.000000000000000000' : '0.000000000000000000', bus_undeliverable_mail: 'N', mail_undeliverable_mail: 'N', ...extra,
});

const list = (where, field) => {
  const m = new RegExp(`(?:^|[^a-z_])${field} in\\(([^)]*)\\)`).exec(where);
  return m ? m[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean) : [];
};
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function licensingFake({ rows = {}, fallback = ACTIVE_ROW, byDot = {}, motus = {}, motusByDot = {} } = {}) {
  const fake = {
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
      const where = u.searchParams.get('$where') || '';
      const dockets = list(where, 'docket_number');
      const ok = (body) => ({ ok: true, status: 200, json: async () => body });
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
