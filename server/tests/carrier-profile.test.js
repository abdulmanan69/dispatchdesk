import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app, registerUser, prisma } from './helpers.js';
import { setSetting, invalidateSettings } from '../src/lib/settings.js';
import { clearCensusCache } from '../src/services/carriers/fmcsaCensus.js';
import { assembleProfile, buildProfile, setProfileFetch, clearProfileCache, peekProfile, LEGACY_AS_OF, day } from '../src/services/carriers/profile.js';
import { normDot } from '../src/services/carriers/normalize.js';

// ---------------------------------------------------------------------------------------------------------------
// Sample rows. MC 647991 / USDOT 1775913 are real rows from data.transportation.gov (Nov 2026): the legacy licensing
// row that showed the authority bug (common 'N', contract 'I', BIPD on file '00000'). The other carriers are made up,
// with the column formats of the real datasets (Motus amounts in dollars, legacy amounts in thousands).
// ---------------------------------------------------------------------------------------------------------------
const NOW = new Date('2026-11-13T12:00:00Z');
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);

const CENSUS_1775913 = {
  mcs150_date: '20251105', add_date: '20080527', status_code: 'A', dot_number: '1775913', dun_bradstreet_no: '6383', carrier_operation: 'A',
  mcs150_mileage: '50000', mcs150_mileage_year: '2024', phone: '4043974031', company_officer_1: 'DERICK DORIAN MYRICK', truck_units: '1',
  power_units: '1', bus_units: '0', fleetsize: 'A', carship: 'C', docket1prefix: 'MC', docket1: '647991', total_intrastate_drivers: '0',
  mcsipstep: '0', mcsipdate: '20240814', hm_ind: 'N', interstate_beyond_100_miles: '1', interstate_within_100_miles: '0',
  intrastate_beyond_100_miles: '0', intrastate_within_100_miles: '0', total_cdl: '0', total_drivers: '1', classdef: 'AUTHORIZED FOR HIRE',
  legal_name: 'DERICK DORIAN MYRICK', dba_name: 'DAKOTA TRUCKING', phy_street: '1317 STONE RUN', phy_city: 'STONE MOUNTAIN', phy_country: 'US',
  phy_state: 'GA', phy_zip: '30083', phy_cnty: '089', carrier_mailing_street: '4501 RUSSWOOD AVE', carrier_mailing_state: 'GA',
  carrier_mailing_city: 'SNELLVILLE', carrier_mailing_country: 'US', carrier_mailing_zip: '30083', carrier_mailing_cnty: '089',
  driver_inter_total: '1', email_address: 'myrick767@gmail.com', crgo_genfreight: 'X', crgo_cargoothr: 'X', crgo_cargoothr_desc: 'APPLIANCES',
  owntruck: '1', docket1_status_code: 'A',
};
const LIC_647991 = {
  docket_number: 'MC647991', dot_number: '01775913', common_stat: 'N', contract_stat: 'I', broker_stat: 'N', common_app_pend: 'N',
  contract_app_pend: 'N', broker_app_pend: 'N', common_rev_pend: 'N', contract_rev_pend: 'N', broker_rev_pend: 'N', property_chk: 'Y',
  passenger_chk: 'N', hhg_chk: 'N', private_auth_chk: 'N', enterprise_chk: 'N', min_cov_amount: '00750', cargo_req: 'N', bond_req: 'N',
  bipd_file: '00000', cargo_file: 'N', bond_file: 'N', undeliverable_mail: 'Y', dba_name: 'DAKOTA TRUCKING', legal_name: 'DERICK DORIAN MYRICK',
  bus_street_po: '4501 RUSSWOOD AVE', bus_city: 'SNELLVILLE', bus_state_code: 'GA', bus_ctry_code: 'US', bus_zip_code: '30083', bus_telno: '4043974031',
};
const AUTHHIST_647991 = [
  { docket_number: 'MC647991', dot_number: '01775913', mod_col_1: 'MOTOR PROPERTY CONTRACT CARRIER', original_action_desc: 'GRANTED', orig_served_date: '07/17/2008', disp_action_desc: 'REVOKED', disp_decided_date: '02/07/2017', disp_served_date: '02/07/2017' },
  { docket_number: 'MC647991', dot_number: '01775913', mod_col_1: 'CONTRACT', original_action_desc: 'INVOLUNTARY REVOCATION', orig_served_date: '06/23/2023', disp_action_desc: 'DISCONTINUED REVOCATION', disp_decided_date: '07/20/2023', disp_served_date: '07/20/2023' },
  { docket_number: 'MC647991', dot_number: '01775913', mod_col_1: 'MOTOR PROPERTY CONTRACT CARRIER', original_action_desc: 'REINSTATED', orig_served_date: '07/29/2021', disp_action_desc: 'REVOKED', disp_decided_date: '10/20/2025', disp_served_date: '10/20/2025' },
  { docket_number: 'MC647991', dot_number: '01775913', mod_col_1: 'CONTRACT', original_action_desc: 'INVOLUNTARY REVOCATION', orig_served_date: '07/29/2025', disp_action_desc: 'DISCONTINUED REVOCATION', disp_decided_date: '07/31/2025', disp_served_date: '07/31/2025' },
  { docket_number: 'MC647991', dot_number: '01775913', mod_col_1: 'CONTRACT', original_action_desc: 'INVOLUNTARY REVOCATION', orig_served_date: '06/22/2022', disp_action_desc: 'DISCONTINUED REVOCATION', disp_decided_date: '07/21/2022', disp_served_date: '07/21/2022' },
];
const INSHIST_647991 = [
  { docket_number: 'MC647991', dot_number: '01775913', ins_form_code: '91X', mod_col_1: 'Cancelled', ins_cancl_form: '35', mod_col_3: 'BIPD/Primary', policy_no: '70TRS123375', min_cov_amount: '750', ins_class_code: 'P', effective_date: '12/16/2022', mod_col_4: '0', mod_col_5: '750', cancl_effective_date: '07/20/2023', cancl_method: 'CANCEL', inser_branch: '01', name_company: 'NATIONAL INDEMNITY COMPANY' },
  { docket_number: 'MC647991', dot_number: '01775913', ins_form_code: '91X', mod_col_1: 'Cancelled', ins_cancl_form: '35', mod_col_3: 'BIPD/Primary', policy_no: 'CA971627453', min_cov_amount: '750', ins_class_code: 'P', effective_date: '08/25/2025', mod_col_4: '0', mod_col_5: '750', cancl_effective_date: '10/14/2025', cancl_method: 'CANCEL', inser_branch: '01', name_company: 'PROGRESSIVE MOUNTAIN INSURANCE COMPANY OF OHI' },
  { docket_number: 'MC647991', dot_number: '01775913', ins_form_code: '91X', mod_col_1: 'Replaced', ins_cancl_form: '91X', mod_col_3: 'BIPD/Primary', policy_no: 'TRV4925402', min_cov_amount: '750', ins_class_code: 'P', effective_date: '06/24/2008', mod_col_4: '0', mod_col_5: '750', cancl_effective_date: '10/01/2010', cancl_method: 'TERM/REPL', inser_branch: '00', name_company: 'VANLINER INSURANCE COMPANY' },
  { docket_number: 'MC647991', dot_number: '01775913', ins_form_code: '91X', mod_col_1: 'Replaced', ins_cancl_form: '91X', mod_col_3: 'BIPD/Primary', policy_no: '9659657', min_cov_amount: '750', ins_class_code: 'P', effective_date: '02/01/2011', mod_col_4: '0', mod_col_5: '1000', cancl_effective_date: '02/01/2014', cancl_method: 'TERM/REPL', inser_branch: '00', name_company: 'ZURICH AMERICAN INS. CO. OF ILLINOIS' },
  { docket_number: 'MC647991', dot_number: '01775913', ins_form_code: '34', mod_col_1: 'Cancelled', ins_cancl_form: '35', mod_col_2: '*', mod_col_3: 'CARGO', policy_no: '9595453', min_cov_amount: '750', effective_date: '10/01/2010', mod_col_4: '0', mod_col_5: '0', cancl_effective_date: '02/28/2014', cancl_method: 'CANCEL', inser_branch: '00', name_company: 'ZURICH AMERICAN INSURANCE COMPANY' },
];

// A large made-up carrier on file in every dataset, with QCMobile data.
const CENSUS_FULL = {
  dot_number: '3100001', legal_name: 'PRAIRIE LINE TRANSPORT INC', dba_name: 'PRAIRIE LINE', status_code: 'A', add_date: '19940301', mcs150_date: '20230915',
  carrier_operation: 'A', classdef: 'AUTHORIZED FOR HIRE', carship: 'C;B', business_org_desc: 'CORPORATION', company_officer_1: 'JANE ROE PRESIDENT',
  company_officer_2: 'JOHN DOE CFO', dun_bradstreet_no: '123456789', phone: '4025550100', cell_phone: '4025550101', fax: '4025550102',
  email_address: 'Safety@PrairieLine.test', phy_street: '100 PRAIRIE LN', phy_city: 'OMAHA', phy_state: 'NE', phy_zip: '68138', phy_country: 'US',
  carrier_mailing_street: 'PO BOX 9', carrier_mailing_city: 'OMAHA', carrier_mailing_state: 'NE', carrier_mailing_zip: '68138', carrier_mailing_country: 'US',
  undeliv_phy: 'U', carrier_mailing_und_date: '20250102', power_units: '120', truck_units: '20', bus_units: '0', total_drivers: '130', total_cdl: '128',
  driver_inter_total: '125', total_intrastate_drivers: '5', avg_drivers_leased_per_month: '4', interstate_beyond_100_miles: '110', interstate_within_100_miles: '15',
  intrastate_beyond_100_miles: '0', intrastate_within_100_miles: '5', mcs150_mileage: '14500000', mcs150_mileage_year: '2022', hm_ind: 'Y',
  crgo_genfreight: 'X', crgo_coldfood: 'X', crgo_beverages: 'X', owntruck: '20', owntract: '90', owntrail: '300', trmtract: '10', trmtrail: '40', trptract: '0', trptrail: '5',
  safety_rating: 'S', safety_rating_date: '20190402', review_type: 'C', review_date: '20190320', recordable_crash_rate: '0.12', prior_revoke_flag: 'Y', prior_revoke_dot_number: '2999999',
  docket1prefix: 'MC', docket1: '900001', docket1_status_code: 'A',
};
const MOTUS_FULL = [
  { docket_number: 'MC900001', usdot_number: '3100001', op_auth_type: 'Broker of Property (Except Household Goods)', op_auth_status: 'Active', min_cov_amount: '0.000000000000000000', cargo_req: 'N', bond_req: 'Y', bipd_file: '5000000.000000000000000000', cargo_file: 'N', bond_file: 'Y', bus_undeliverable_mail: 'Y', mail_undeliverable_mail: 'Y', legal_name: 'PRAIRIE LINE TRANSPORT INC', bus_street_po: '100 PRAIRIE LN', bus_city: 'OMAHA', bus_state_code: 'NE', bus_zip_code: '68138', bus_ctry_code: 'US', bus_telno: '+1 (402) 555-0100' },
  { docket_number: 'MC900001', usdot_number: '3100001', op_auth_type: 'Motor Carrier of Property (Except Household Goods)', op_auth_status: 'Active', min_cov_amount: '750000.000000000000000000', cargo_req: 'N', bond_req: 'N', bipd_file: '5000000.000000000000000000', cargo_file: 'Y', bond_file: 'N', bus_undeliverable_mail: 'Y', mail_undeliverable_mail: 'Y', legal_name: 'PRAIRIE LINE TRANSPORT INC', bus_street_po: '100 PRAIRIE LN', bus_city: 'OMAHA', bus_state_code: 'NE', bus_zip_code: '68138', bus_ctry_code: 'US', bus_telno: '+1 (402) 555-0100' },
];
const LIC_FULL = { ...LIC_647991, docket_number: 'MC900001', dot_number: '03100001', common_stat: 'A', contract_stat: 'A', broker_stat: 'A', bipd_file: '05000', legal_name: 'PRAIRIE LINE TRANSPORT INC' };
const MOTUS_INS_FULL = [
  { docket_number: 'MC900001', usdot_number: '3100001', ins_form_code: 'BMC-91X', ins_type_code: '1', ins_class_code: 'E', max_cov_amount: '4000000.00', underl_lim_amount: '1000000.00', policy_no: 'XS-100', effective_date: '20250801', insurance_company_name: 'Ace Excess Insurance Company', trans_date: '20250725' },
  { docket_number: 'MC900001', usdot_number: '3100001', ins_form_code: 'BMC-91X', ins_type_code: '1', ins_class_code: 'E', max_cov_amount: '4000000.00', underl_lim_amount: '1000000.00', policy_no: 'XS-100', effective_date: '20250801', insurance_company_name: 'Ace Excess Insurance Company', trans_date: '20250725' },
  { docket_number: 'MC900001', usdot_number: '3100001', ins_form_code: 'BMC-91X', ins_type_code: '1', ins_class_code: 'P', max_cov_amount: '1000000.00', underl_lim_amount: '0.00', policy_no: 'SI-1', effective_date: '19980610', insurance_company_name: 'Self-Insured', trans_date: '19980601' },
  { docket_number: 'MC900001', usdot_number: '3100001', ins_form_code: 'BMC-84', ins_type_code: '3', ins_class_code: 'P', max_cov_amount: '75000.00', underl_lim_amount: '0.00', policy_no: 'BND-7', effective_date: '20131001', insurance_company_name: 'Surety Co of America', trans_date: '20130920' },
];
const LEGACY_INS_FULL = [
  { docket_number: 'MC900001', dot_number: '03100001', ins_form_code: '91X', mod_col_1: 'BIPD/Excess', name_company: 'ACE EXCESS INSURANCE COMPANY', policy_no: 'XS-100', trans_date: '07/25/2025', underl_lim_amount: '1000', max_cov_amount: '4000', effective_date: '08/01/2025' },
  { docket_number: 'MC900001', dot_number: '03100001', ins_form_code: '91X', mod_col_1: 'BIPD/Primary', name_company: 'SELF-INSURED', policy_no: 'SI 1', trans_date: '06/01/1998', underl_lim_amount: '0', max_cov_amount: '1000', effective_date: '06/10/1998' },
  { docket_number: 'MC900001', dot_number: '03100001', ins_form_code: '34', mod_col_1: 'CARGO', name_company: 'ACME CARGO INSURANCE', policy_no: 'CG-9', trans_date: '12/20/2019', underl_lim_amount: '0', max_cov_amount: '0', effective_date: '01/01/2020' },
  { docket_number: 'MC900001', dot_number: '03100001', ins_form_code: '91X', mod_col_1: 'BIPD/Primary', name_company: 'OLD MUTUAL CASUALTY', policy_no: 'OLD-1', trans_date: '12/20/2018', underl_lim_amount: '0', max_cov_amount: '750', effective_date: '01/01/2019', cancl_effective_date: '01/01/2020' },
];
const AUTHHIST_FULL = [
  { docket_number: 'MC900001', dot_number: '03100001', mod_col_1: 'MOTOR PROPERTY COMMON CARRIER', original_action_desc: 'GRANTED', orig_served_date: '04/12/1994' },
  { docket_number: 'MC900001', dot_number: '03100001', mod_col_1: 'PROPERTY BROKER', original_action_desc: 'GRANTED', orig_served_date: '05/01/2001' },
];
const MOTUS_INSHIST_FULL = [
  { docket_number: 'MC900001', usdot_number: '3100001', ins_form_code: 'BMC-91X', filing_status_reason: 'CANCEL', ins_type_code: '1', ins_type_ind: ' ', policy_no: 'GAP-2', ins_type_desc: 'BIPD/Primary', min_cov_amount: '750000.0', ins_class_code: 'P', effective_date: '20200101', underl_lim_amount: '0.00', max_cov_amount: '1000000.00', cancl_effective_date: '20200301', insurance_company_name: 'Gap Mutual' },
];
const QC_FULL = {
  carrier: { content: { carrier: {
    dotNumber: 3100001, legalName: 'PRAIRIE LINE TRANSPORT INC', statusCode: 'A', allowedToOperate: 'Y', oosDate: null, safetyRating: 'S', safetyRatingDate: '2019-04-02',
    bipdInsuranceOnFile: '5000', bipdRequiredAmount: '750', bipdInsuranceRequired: 'Y', cargoInsuranceOnFile: '0', cargoInsuranceRequired: 'N', bondInsuranceOnFile: '75', bondInsuranceRequired: 'Y',
    crashTotal: 12, fatalCrash: 1, injCrash: 4, towawayCrash: 7, driverInsp: 400, driverOosInsp: 12, driverOosRate: 3, driverOosRateNationalAverage: '5.51',
    vehicleInsp: 300, vehicleOosInsp: 90, vehicleOosRate: 30, vehicleOosRateNationalAverage: '20.72', hazmatInsp: 10, hazmatOosInsp: 0, hazmatOosRate: 0,
    hazmatOosRateNationalAverage: '4.5', oosRateNationalAverageYear: '2009-2010', totalPowerUnits: 120, totalDrivers: 130,
  } } },
  basics: { content: [
    { basic: { basicsType: { basicsShortDesc: 'Unsafe Driving' }, basicsPercentile: '72', basicsViolationThreshold: '65', exceededFMCSAInterventionThreshold: 'Y', onRoadPerformanceThresholdViolationIndicator: 'Y', seriousViolationFromInvestigationPast12MonthIndicator: 'N', measureValue: '3.1', totalInspectionWithViolation: 20, totalViolation: 25, basicsRunDate: '2026-10-31T04:00:00.000+0000' } },
    { basic: { basicsType: { basicsShortDesc: 'Crash Indicator' }, basicsPercentile: 'Not Public', basicsViolationThreshold: '65', exceededFMCSAInterventionThreshold: 'N', onRoadPerformanceThresholdViolationIndicator: 'N', seriousViolationFromInvestigationPast12MonthIndicator: 'N', measureValue: '0.4' } },
  ] },
  'cargo-classification': { content: [{ cargoClassDesc: 'General Freight' }] },
  'operation-classification': { content: [{ operationClassDesc: 'Authorized For Hire' }] },
  'docket-numbers': { content: [{ docketNumber: 900001, prefix: 'MC', dotNumber: 3100001 }] },
  authority: { content: [{ carrierAuthority: { commonAuthorityStatus: 'A', contractAuthorityStatus: 'A', brokerAuthorityStatus: 'A', docketNumber: 900001, prefix: 'MC' } }] },
};

// A carrier registered in Motus only (new 8-digit MC), granted three days ago; Motus bipd_file still 0 but the
// BIPD policy is on file.
const CENSUS_NEW = {
  dot_number: '4700001', legal_name: 'BLUE HERON FREIGHT LLC', status_code: 'A', add_date: ymd(daysAgo(30)), mcs150_date: ymd(daysAgo(30)), carrier_operation: 'A',
  classdef: 'AUTHORIZED FOR HIRE', carship: 'C', phone: '3315550199', phy_street: '7 HERON WAY', phy_city: 'CARPENTERSVILLE', phy_state: 'IL', phy_zip: '60110',
  power_units: '1', total_drivers: '1', owntract: '1', crgo_genfreight: 'X',
};
const MOTUS_NEW = [{ docket_number: 'MC65500001', usdot_number: '4700001', op_auth_type: 'Motor Carrier of Property (Except Household Goods)', op_auth_status: 'Active', min_cov_amount: '750000.000000000000000000', cargo_req: 'N', bond_req: 'N', bipd_file: '0.000000000000000000', cargo_file: 'N', bond_file: 'N', bus_undeliverable_mail: 'Y', mail_undeliverable_mail: 'Y', legal_name: 'BLUE HERON FREIGHT LLC', bus_telno: '+1 (331) 555-0199' }];
const MOTUS_INS_NEW = [{ docket_number: 'MC65500001', usdot_number: '4700001', ins_form_code: 'BMC-91X', ins_type_code: '1', ins_class_code: 'P', max_cov_amount: '750000.00', underl_lim_amount: '0.00', policy_no: 'CA-NEW-1', effective_date: ymd(daysAgo(3)), insurance_company_name: 'Artisan Casualty Company', trans_date: ymd(daysAgo(8)) }];
const MOTUS_AUTHHIST_NEW = [
  { docket_number: 'MC65500001', usdot_number: '4700001', op_auth_type: 'Motor Carrier of Property (Except Household Goods)', op_auth_status: 'Active', reason: 'Granted', status_change_date: ymd(daysAgo(3)) },
  { docket_number: 'MC65500001', usdot_number: '4700001', op_auth_type: 'Motor Carrier of Property (Except Household Goods)', op_auth_status: 'Pending', reason: 'Published to FMCSA Register', status_change_date: ymd(daysAgo(20)) },
  { docket_number: 'MC65500001', usdot_number: '4700001', op_auth_type: 'Motor Carrier of Property (Except Household Goods)', op_auth_status: 'Pending', reason: 'Withdrawn by someone@example.test', status_change_date: ymd(daysAgo(25)) },
];

// Dataset id -> USDOT -> rows.
const WORLD = {
  'az4n-8mr2': { 1775913: [CENSUS_1775913], 3100001: [CENSUS_FULL], 4700001: [CENSUS_NEW] },
  '6eyk-hxee': { 1775913: [LIC_647991], 3100001: [LIC_FULL] },
  'inys-ebih': { 3100001: MOTUS_FULL, 4700001: MOTUS_NEW },
  'qh9u-swkp': { 3100001: LEGACY_INS_FULL },
  'c5y8-a4uz': { 3100001: MOTUS_INS_FULL, 4700001: MOTUS_INS_NEW },
  '6sqe-dvqs': { 1775913: INSHIST_647991 },
  '3uet-3z4i': { 3100001: MOTUS_INSHIST_FULL },
  '9mw4-x3tu': { 1775913: AUTHHIST_647991, 3100001: AUTHHIST_FULL },
  'yu5v-wbh6': { 4700001: MOTUS_AUTHHIST_NEW },
};
const QC_WORLD = { 3100001: QC_FULL };

const reply = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers({ 'last-modified': 'Thu, 12 Nov 2026 21:07:14 GMT' }), json: async () => body });

/** Fake data.transportation.gov + QCMobile. `fail` lists dataset ids (or 'qcmobile') that answer 500. */
function fakeFmcsa({ fail = [] } = {}) {
  const calls = [];
  const fn = vi.fn(async (input) => {
    const u = new URL(String(input));
    if (u.host === 'mobile.fmcsa.dot.gov') {
      calls.push(`qc:${u.pathname.replace('/qc/services', '')}`);
      if (fail.includes('qcmobile')) return reply({}, 500);
      const m = u.pathname.match(/\/carriers\/(\d+)(?:\/(.+))?$/);
      const body = QC_WORLD[m?.[1]]?.[m?.[2] || 'carrier'];
      return body === undefined ? reply({}, 404) : reply(body);
    }
    if (u.host !== 'data.transportation.gov') throw new Error(`unexpected request in a test: ${u.host}`);
    const id = u.pathname.split('/').pop().replace('.json', '');
    const where = u.searchParams.get('$where') || '';
    calls.push(`${id}:${where}`);
    if (fail.includes(id)) return reply({ message: 'boom' }, 500);
    const byDocket = where.match(/docket1='(\d+)'/);
    if (byDocket) return reply(Object.values(WORLD[id] || {}).flat().filter((r) => r.docket1 === byDocket[1]));
    const dots = [...where.matchAll(/'(\d+)'/g)].map((x) => normDot(x[1]));
    return reply([...new Set(dots)].flatMap((d) => WORLD[id]?.[d] || []));
  });
  setProfileFetch(fn);
  return { fn, calls };
}

const ok = (rows) => ({ ok: true, rows, asOf: '2026-11-12T21:07:14.000Z' });
const down = { ok: false, error: 'Answered 500' };
const NO_QC = { ok: false, skipped: true, error: 'Not set up' };
const src647991 = (over = {}) => ({
  census: ok([CENSUS_1775913]), licensing: ok([LIC_647991]), motus: ok([]), insurance: ok([]), motusInsurance: ok([]),
  insuranceHistory: ok(INSHIST_647991), motusInsuranceHistory: ok([]), authorityHistory: ok(AUTHHIST_647991), motusAuthorityHistory: ok([]),
  qcmobile: NO_QC, ...over,
});
const codes = (p) => p.flags.map((f) => `${f.level}:${f.code}`);

afterAll(() => setProfileFetch(null));
beforeEach(() => { clearCensusCache(); clearProfileCache(); });

describe('FMCSA profile normalization', () => {
  it('reads FMCSA dates in every dataset format', () => {
    expect(day('20251105')).toBe('2025-11-05');
    expect(day('07/17/2008')).toBe('2008-07-17');
    expect(day('2019-04-02T05:00:00.000+0000')).toBe('2019-04-02');
    expect(day('')).toBeNull();
    expect(day('13/45/2020')).toBeNull();
  });

  it('MC 647991 (legacy common N, contract I, BIPD 00000): authority inactive with red flags, history and age', () => {
    const p = assembleProfile(src647991(), { dot: '1775913', now: NOW });
    expect(p).toMatchObject({ dot: '1775913', mc: '647991', found: true, complete: true });
    expect(p.identity).toMatchObject({ legalName: 'DERICK DORIAN MYRICK', dbaName: 'DAKOTA TRUCKING', usdotStatus: 'active', registeredAt: '2008-05-27', officers: ['DERICK DORIAN MYRICK'], dunsNumber: '6383' });
    expect(p.identity.dockets).toEqual([expect.objectContaining({ docket: 'MC647991', status: 'active', source: 'census' })]);
    expect(p.authority).toMatchObject({ status: 'inactive', code: 'inactive', basis: 'legacy', legacyAsOf: LEGACY_AS_OF, insuranceOnFile: false, revocationPending: false });
    expect(p.authority.types).toEqual([{ docket: 'MC647991', type: 'Contract carrier (property)', kind: 'carrier', status: 'inactive', source: 'legacy' }]);
    expect(p.authority).toMatchObject({ since: '2008-07-17', revokedBefore: true, lastRevokedAt: '2025-10-20', revocations: 2 });
    expect(p.authority.ageYears).toBeCloseTo(18.3, 1);
    expect(p.authority.history[0]).toMatchObject({ date: '2025-10-20', action: 'Revoked', docket: 'MC647991', type: 'Motor property contract carrier' });
    expect(p.authority.history.some((e) => e.action === 'Reinstated' && e.date === '2021-07-29')).toBe(true);
    expect(codes(p)).toEqual(expect.arrayContaining(['red:authority_inactive', 'red:no_insurance', 'amber:revoked_before']));
    expect(codes(p)).not.toContain('green:authority_active');
    expect(p.flags[0].level).toBe('red');

    expect(p.insurance.onFile).toEqual([]);
    expect(p.insurance.required).toEqual({ bipd: 750000, cargo: false, bond: false });
    expect(p.insurance.filed).toEqual({ bipd: 0, cargo: false, bond: false });
    expect(p.insurance.history[0]).toMatchObject({ category: 'bipd', type: 'BIPD (primary)', company: 'PROGRESSIVE MOUNTAIN INSURANCE COMPANY OF OHI', policy: 'CA971627453', coverage: 750000, effective: '2025-08-25', cancelEffective: '2025-10-14', reason: 'Cancelled' });
    expect(p.insurance.history.find((h) => h.policy === '9659657')).toMatchObject({ coverage: 1000000, reason: 'Replaced' });
    expect(p.insurance.history.find((h) => h.category === 'cargo')).toMatchObject({ type: 'Cargo', coverage: null });
    expect(p.insurance.lapses[0]).toEqual({ from: '2023-07-20', to: '2025-08-25', days: 767 });

    expect(p.contact).toMatchObject({
      phone: '4043974031', email: 'myrick767@gmail.com', physicalUndeliverable: false, mailingUndeliverableSince: null,
      physicalAddress: { street: '1317 STONE RUN', city: 'STONE MOUNTAIN', state: 'GA', zip: '30083', country: 'US' },
      mailingAddress: { street: '4501 RUSSWOOD AVE', city: 'SNELLVILLE', state: 'GA', zip: '30083', country: 'US' },
    });
    // Licensing address status Y = deliverable (data dictionary), so no undeliverable flag.
    expect(p.contact.licensing).toMatchObject({ undeliverable: false, source: 'legacy', sameAsCensus: false });
    expect(codes(p)).not.toContain('amber:undeliverable');
    expect(p.operation).toEqual({ available: true, partial: false, carrierOperation: 'Interstate', classifications: ['Authorized for hire'], entityTypes: ['Carrier'], hazmat: false });
    expect(p.cargo).toEqual(['General freight', 'Other: Appliances']);
    expect(p.fleet).toMatchObject({ powerUnits: 1, trucks: 1, buses: 0 });
    expect(p.equipment.rows.slice(0, 3)).toEqual([
      { kind: 'Trucks', owned: 1, termLeased: 0, tripLeased: 0 }, { kind: 'Tractors', owned: 0, termLeased: 0, tripLeased: 0 }, { kind: 'Trailers', owned: 0, termLeased: 0, tripLeased: 0 },
    ]);
    expect(p.drivers).toMatchObject({ total: 1, cdl: 0, interstate: 1, intrastate: 0, interstateBeyond100: 1 });
    expect(p.mileage).toMatchObject({ miles: 50000, year: 2024 });
    expect(p.compliance).toMatchObject({ mcs150Date: '2025-11-05', mcs150AgeMonths: 12, outdated: false, priorRevoke: { flag: null, dot: null } });
    expect(p.safety).toMatchObject({ available: true, live: false, liveStatus: 'not_configured', rating: null, inspections: null, crashes: null, basics: null, allowedToOperate: null });
    const legacy = p.sources.find((x) => x.key === 'licensing');
    expect(legacy).toMatchObject({ ok: true, status: 'ok', dataset: '6eyk-hxee', asOf: LEGACY_AS_OF, url: 'https://data.transportation.gov/d/6eyk-hxee' });
    expect(p.sources.find((x) => x.key === 'census').asOf).toBe('2026-11-12T21:07:14.000Z');
    expect(p.sources.find((x) => x.key === 'qcmobile')).toMatchObject({ ok: false, status: 'skipped' });
    expect(p.saferUrl).toContain('query_string=1775913');
  });

  it('a carrier on file everywhere (Motus, legacy, QCMobile): active, insurance merged, safety from QCMobile', () => {
    const qcmobile = {
      ok: true, skipped: false, found: true, carrier: QC_FULL.carrier.content.carrier, basics: QC_FULL.basics.content, cargo: QC_FULL['cargo-classification'].content,
      operations: QC_FULL['operation-classification'].content, dockets: QC_FULL['docket-numbers'].content, authority: QC_FULL.authority.content, partErrors: {},
    };
    const p = assembleProfile({
      census: ok([CENSUS_FULL]), licensing: ok([LIC_FULL]), motus: ok(MOTUS_FULL), insurance: ok(LEGACY_INS_FULL), motusInsurance: ok(MOTUS_INS_FULL),
      insuranceHistory: ok([]), motusInsuranceHistory: ok(MOTUS_INSHIST_FULL), authorityHistory: ok(AUTHHIST_FULL), motusAuthorityHistory: ok([]), qcmobile,
    }, { dot: '3100001', now: NOW });
    expect(p.authority).toMatchObject({ status: 'active', code: 'active', basis: 'motus', legacyAsOf: null, insuranceOnFile: true, since: '1994-04-12', docket: 'MC900001' });
    expect(p.authority.types.map((t) => `${t.kind}:${t.status}:${t.source}`)).toEqual(['broker:active:motus', 'carrier:active:motus']);
    expect(p.authority.required).toEqual({ bipd: 750000, cargo: false, bond: false });
    // Motus first; legacy duplicates (same policy and date, any spelling) dropped; the ended legacy policy moves to history.
    expect(p.insurance.onFile.map((x) => `${x.type}|${x.policy}|${x.coverage}|${x.source}`)).toEqual([
      'BIPD (excess)|XS-100|4000000|motus', 'BIPD (primary)|SI-1|1000000|motus', 'Cargo|CG-9|null|legacy', 'Surety bond|BND-7|75000|motus',
    ]);
    expect(p.insurance.onFile[0]).toMatchObject({ underlying: 1000000, effective: '2025-08-01', company: 'Ace Excess Insurance Company' });
    expect(p.insurance.history.map((h) => `${h.policy}|${h.reason}|${h.cancelEffective}`)).toEqual(['GAP-2|Cancelled|2020-03-01', 'OLD-1|Cancelled|2020-01-01']);
    expect(p.contact).toMatchObject({ email: 'safety@prairieline.test', cellPhone: '4025550101', fax: '4025550102', physicalUndeliverable: true, mailingUndeliverableSince: '2025-01-02' });
    expect(p.contact.licensing).toMatchObject({ phone: '4025550100', source: 'motus', undeliverable: false, sameAsCensus: true });
    expect(p.identity).toMatchObject({ businessType: 'Corporation', officers: ['JANE ROE PRESIDENT', 'JOHN DOE CFO'] });
    expect(p.operation).toMatchObject({ classifications: ['Authorized for hire'], entityTypes: ['Carrier', 'Broker'], hazmat: true });
    expect(p.cargo).toEqual(['General freight', 'Refrigerated food', 'Beverages']);
    expect(p.equipment.rows.find((r) => r.kind === 'Tractors')).toEqual({ kind: 'Tractors', owned: 90, termLeased: 10, tripLeased: 0 });
    expect(p.equipment.rows.find((r) => r.kind === 'Trailers')).toEqual({ kind: 'Trailers', owned: 300, termLeased: 40, tripLeased: 5 });
    expect(p.drivers).toMatchObject({ total: 130, cdl: 128, avgLeasedPerMonth: 4, intrastateWithin100: 5 });
    expect(p.safety).toMatchObject({
      live: true, liveStatus: 'ok', rating: 'Satisfactory', ratingDate: '2019-04-02', allowedToOperate: true, oosDate: null,
      review: { type: 'Compliance review', code: 'C', date: '2019-03-20' }, recordableCrashRate: 0.12, crashes: { fatal: 1, injury: 4, tow: 7, total: 12 },
    });
    expect(p.safety.inspections.vehicle).toEqual({ inspections: 300, oos: 90, oosRate: 30, nationalAvg: 20.7 });
    expect(p.safety.inspections.driver).toEqual({ inspections: 400, oos: 12, oosRate: 3, nationalAvg: 5.5 });
    expect(p.safety.basics).toEqual([
      expect.objectContaining({ name: 'Unsafe Driving', percentile: 72, threshold: 65, alert: true, violations: 25, runDate: '2026-10-31' }),
      expect.objectContaining({ name: 'Crash Indicator', percentile: null, alert: false }),
    ]);
    expect(p.compliance).toMatchObject({ mcs150Date: '2023-09-15', outdated: true, priorRevoke: { flag: true, dot: '2999999' } });
    expect(codes(p)).toEqual(expect.arrayContaining([
      'amber:mcs150_outdated', 'amber:undeliverable', 'amber:high_oos_vehicle', 'amber:basic_alert', 'amber:prior_usdot_revoked',
      'green:authority_active', 'green:authority_age', 'green:rating_satisfactory', 'green:allowed',
    ]));
    expect(codes(p)).not.toContain('amber:high_oos_driver');
    expect(p.flags.find((f) => f.code === 'high_oos_vehicle').text).toBe('Vehicle out-of-service rate 30% vs 20.7% national average');
    expect(p.flags.filter((f) => f.level === 'red')).toEqual([]);
  });

  it('a Motus-only carrier (8-digit MC, BIPD policy on file, Motus bipd_file still 0) is active, with a new-authority flag', () => {
    const p = assembleProfile({
      census: ok([CENSUS_NEW]), licensing: ok([]), motus: ok(MOTUS_NEW), insurance: ok([]), motusInsurance: ok(MOTUS_INS_NEW),
      insuranceHistory: ok([]), motusInsuranceHistory: ok([]), authorityHistory: ok([]), motusAuthorityHistory: ok(MOTUS_AUTHHIST_NEW), qcmobile: NO_QC,
    }, { dot: '4700001', now: new Date() });
    expect(p.mc).toBe('65500001');
    expect(p.authority).toMatchObject({ status: 'active', basis: 'motus', insuranceOnFile: true, since: day(ymd(daysAgo(3))), ageDays: 3, revokedBefore: false });
    expect(p.authority.history.map((e) => e.action)).toEqual(['Granted', 'Published to FMCSA register', 'Withdrawn']); // email removed from the reason
    expect(p.insurance.onFile).toEqual([expect.objectContaining({ type: 'BIPD (primary)', company: 'Artisan Casualty Company', coverage: 750000, source: 'motus' })]);
    expect(codes(p)).toEqual(expect.arrayContaining(['amber:new_authority', 'green:authority_active']));
    expect(codes(p).some((c) => c.startsWith('red:'))).toBe(false);
  });

  it('a failed source makes only its section unavailable; the others stay filled', () => {
    const p = assembleProfile(src647991({ licensing: down, insuranceHistory: down, motusInsuranceHistory: down }), { dot: '1775913', now: NOW });
    expect(p.complete).toBe(false);
    expect(p.authority).toMatchObject({ status: 'unknown', code: 'unknown', partial: true });
    expect(codes(p)).toContain('amber:authority_unknown');
    expect(codes(p)).not.toContain('red:authority_inactive');
    expect(p.insurance.history).toBeNull();
    expect(p.insurance.lapses).toBeNull();
    expect(p.identity.legalName).toBe('DERICK DORIAN MYRICK');
    expect(p.operation.available).toBe(true);
    expect(p.authority.since).toBe('2008-07-17'); // authority history still answered
    expect(p.sources.find((x) => x.key === 'licensing')).toMatchObject({ ok: false, status: 'failed', error: 'Answered 500', asOf: null });

    // Census down: identity and contact come from the licensing row; census-only sections say they are unavailable.
    const q = assembleProfile(src647991({ census: down }), { dot: '1775913', now: NOW });
    expect(q.identity).toMatchObject({ partial: true, legalName: 'DERICK DORIAN MYRICK', source: 'legacy' });
    expect(q.contact).toMatchObject({ partial: true, phone: '4043974031' });
    expect(q.operation.available).toBe(false);
    expect(q.equipment.available).toBe(false);
    expect(q.compliance.available).toBe(false);
    expect(q.safety.available).toBe(false);
    expect(q.cargo).toBeNull();
    expect(q.authority.status).toBe('inactive');
  });
});

describe('buildProfile', () => {
  it('queries every dataset by USDOT number (padded and unpadded) and never calls QCMobile without a web key', async () => {
    const { calls } = fakeFmcsa();
    const p = await buildProfile({ dot: '1775913' });
    expect(p.authority.status).toBe('inactive');
    expect(calls.some((c) => c.startsWith('qc:'))).toBe(false);
    expect(calls).toContain("inys-ebih:usdot_number in('1775913','01775913')");
    expect(calls).toContain("6eyk-hxee:dot_number in('1775913','01775913')");
    expect(calls).toHaveLength(9);
  });

  it('serves the second request from the cache (no upstream calls) and refetches when fresh', async () => {
    const { fn } = fakeFmcsa();
    const [a, b] = await Promise.all([buildProfile({ dot: '1775913' }), buildProfile({ dot: '1775913' })]);
    expect(a).toBe(b); // concurrent requests share one build
    const n = fn.mock.calls.length;
    await buildProfile({ dot: '1775913' });
    expect(fn.mock.calls.length).toBe(n);
    expect(peekProfile('1775913')).toBe(a);
    await buildProfile({ dot: '1775913' }, { fresh: true });
    expect(fn.mock.calls.length).toBe(2 * n);
  });

  it('resolves an MC number through the census', async () => {
    fakeFmcsa();
    const p = await buildProfile({ mc: '647991' });
    expect(p.dot).toBe('1775913');
  });

  it('uses QCMobile when a web key is set', async () => {
    const admin = await registerUser();
    await setSetting('fmcsa.webKey', 'test-web-key', admin.user.id);
    invalidateSettings();
    try {
      const { calls } = fakeFmcsa();
      const p = await buildProfile({ dot: '3100001' });
      expect(calls.filter((c) => c.startsWith('qc:')).sort()).toEqual([
        'qc:/carriers/3100001', 'qc:/carriers/3100001/authority', 'qc:/carriers/3100001/basics', 'qc:/carriers/3100001/cargo-classification',
        'qc:/carriers/3100001/docket-numbers', 'qc:/carriers/3100001/operation-classification',
      ]);
      expect(p.safety).toMatchObject({ live: true, rating: 'Satisfactory', allowedToOperate: true });
      expect(p.safety.basics).toHaveLength(2);
      expect(p.sources.find((s) => s.key === 'qcmobile')).toMatchObject({ ok: true, status: 'ok' });
      expect(JSON.stringify(p)).not.toContain('test-web-key');

      // QCMobile down: the profile still builds, safety falls back to the census.
      clearProfileCache();
      fakeFmcsa({ fail: ['qcmobile'] });
      const q = await buildProfile({ dot: '3100001' });
      expect(q.safety).toMatchObject({ live: false, liveStatus: 'failed', rating: 'Satisfactory', inspections: null });
      expect(q.complete).toBe(false);
    } finally {
      await setSetting('fmcsa.webKey', '', admin.user.id);
      invalidateSettings();
    }
  });
});

describe('carrier profile API', () => {
  let A;
  let B;
  let stageId;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    stageId = (await prisma.pipelineStage.findUnique({ where: { key: 'lead' } })).id;
  });
  afterEach(() => { delete process.env.CARRIER_PROFILE_RATE_LIMIT; });
  const makeCarrier = (ownerId, data) => prisma.carrier.create({ data: { ownerId, stageId, companyName: `Profile ${Date.now()} ${Math.random()}`, ...data } });

  it('GET /dot/:dot returns the profile; unknown numbers are 404 (and cached), bad input 400', async () => {
    const { fn } = fakeFmcsa();
    const res = await A.agent.get('/api/carrier-profile/dot/1775913');
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({ dot: '1775913', mc: '647991', authority: { status: 'inactive' } });
    const missing = await A.agent.get('/api/carrier-profile/dot/9999991');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/No FMCSA census record for USDOT 9999991/);
    const n = fn.mock.calls.length;
    expect((await A.agent.get('/api/carrier-profile/dot/9999991')).status).toBe(404);
    expect(fn.mock.calls.length).toBe(n);
    expect((await A.agent.get('/api/carrier-profile/dot/abc')).status).toBe(400);
  });

  it('requires a session; API tokens may read', async () => {
    fakeFmcsa();
    expect((await request(app).get('/api/carrier-profile/dot/1775913')).status).toBe(401);
    const token = (await A.agent.post('/api/tokens').send({ name: 'profile', expiresInDays: null })).body.token;
    const res = await request(app).get('/api/carrier-profile/dot/1775913').set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.body.profile.dot).toBe('1775913');
  });

  it('GET /carrier/:id stores the profile on the carrier, reuses it within 24 hours, and refetches on refresh=1', async () => {
    const carrier = await makeCarrier(A.user.id, { dotNumber: '1775913', mcNumber: '647991' });
    const { fn } = fakeFmcsa();
    const first = await A.agent.get(`/api/carrier-profile/carrier/${carrier.id}`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ stored: false, profile: { dot: '1775913', authority: { status: 'inactive' } } });
    const row = await prisma.carrier.findUnique({ where: { id: carrier.id } });
    const snap = JSON.parse(row.fmcsaSnapshot);
    expect(snap.profile.fetchedAt).toBe(first.body.profile.fetchedAt);
    expect(row.fmcsaCheckedAt.toISOString()).toBe(first.body.profile.fetchedAt);
    expect(row.updatedAt.getTime()).toBe(carrier.updatedAt.getTime()); // viewing is not an edit

    clearProfileCache(); // the stored copy answers, not the process cache
    const n = fn.mock.calls.length;
    const second = await A.agent.get(`/api/carrier-profile/carrier/${carrier.id}`);
    expect(second.body).toMatchObject({ stored: true, profile: { fetchedAt: first.body.profile.fetchedAt } });
    expect(fn.mock.calls.length).toBe(n);

    // Older than 24 hours: rebuilt.
    await prisma.carrier.update({ where: { id: carrier.id }, data: { fmcsaSnapshot: JSON.stringify({ profile: { ...snap.profile, fetchedAt: new Date(Date.now() - 25 * 3600_000).toISOString() } }) } });
    const third = await A.agent.get(`/api/carrier-profile/carrier/${carrier.id}`);
    expect(third.body.stored).toBe(false);
    expect(fn.mock.calls.length).toBe(2 * n);

    const refreshed = await A.agent.get(`/api/carrier-profile/carrier/${carrier.id}?refresh=1`);
    expect(refreshed.body.stored).toBe(false);
    expect(fn.mock.calls.length).toBe(3 * n);
    expect(JSON.parse((await prisma.carrier.findUnique({ where: { id: carrier.id } })).fmcsaSnapshot).profile.fetchedAt).toBe(refreshed.body.profile.fetchedAt);
  });

  it('keeps the FMCSA watchlist snapshot (and its checked time) next to the profile', async () => {
    const checkedAt = new Date('2026-11-10T03:00:00Z');
    const watch = { v: 1, found: true, usdotStatus: 'active', carrierAuthority: 'active', insuranceOnFile: true, lastChange: null };
    const W = await registerUser();
    const carrier = await makeCarrier(W.user.id, { dotNumber: '1775913', fmcsaSnapshot: JSON.stringify(watch), fmcsaCheckedAt: checkedAt });
    fakeFmcsa();
    expect((await W.agent.get(`/api/carrier-profile/carrier/${carrier.id}`)).status).toBe(200);
    const row = await prisma.carrier.findUnique({ where: { id: carrier.id } });
    const snap = JSON.parse(row.fmcsaSnapshot);
    expect(snap).toMatchObject(watch);
    expect(snap.profile.dot).toBe('1775913');
    expect(row.fmcsaCheckedAt.toISOString()).toBe(checkedAt.toISOString());
  });

  it('answers 404 for a carrier the user cannot read, without calling FMCSA', async () => {
    const carrier = await makeCarrier(A.user.id, { dotNumber: '3100001' });
    const { fn } = fakeFmcsa();
    const res = await B.agent.get(`/api/carrier-profile/carrier/${carrier.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Carrier not found');
    expect(fn).not.toHaveBeenCalled();
    expect((await B.agent.get('/api/carrier-profile/carrier/does-not-exist')).status).toBe(404);
  });

  it('asks for a USDOT number when the carrier has none', async () => {
    const carrier = await makeCarrier(A.user.id, {});
    fakeFmcsa();
    const res = await A.agent.get(`/api/carrier-profile/carrier/${carrier.id}`);
    expect(res.status).toBe(400);
  });

  it('serves the last stored copy (marked stale) when FMCSA is down', async () => {
    const S = await registerUser();
    const carrier = await makeCarrier(S.user.id, { dotNumber: '1775913' });
    fakeFmcsa();
    const first = await S.agent.get(`/api/carrier-profile/carrier/${carrier.id}`);
    fakeFmcsa({ fail: ['az4n-8mr2', '6eyk-hxee', 'inys-ebih', 'qh9u-swkp', 'c5y8-a4uz', '6sqe-dvqs', '3uet-3z4i', '9mw4-x3tu', 'yu5v-wbh6'] });
    const res = await S.agent.get(`/api/carrier-profile/carrier/${carrier.id}?refresh=1`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stored: true, stale: true, profile: { fetchedAt: first.body.profile.fetchedAt } });
    expect((await A.agent.get('/api/carrier-profile/dot/1775913?refresh=1')).status).toBe(502);
  });

  it('limits profile builds per user; cached answers do not count', async () => {
    process.env.CARRIER_PROFILE_RATE_LIMIT = '2';
    const C = await registerUser();
    fakeFmcsa();
    expect((await C.agent.get('/api/carrier-profile/dot/1775913?refresh=1')).status).toBe(200);
    expect((await C.agent.get('/api/carrier-profile/dot/1775913')).status).toBe(200); // cached: free
    expect((await C.agent.get('/api/carrier-profile/dot/1775913')).status).toBe(200);
    expect((await C.agent.get('/api/carrier-profile/dot/3100001')).status).toBe(200);
    const limited = await C.agent.get('/api/carrier-profile/dot/4700001');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatch(/Too many FMCSA profile lookups/);
    expect((await C.agent.get('/api/carrier-profile/dot/1775913')).status).toBe(200); // still cached
    expect((await A.agent.get('/api/carrier-profile/dot/4700001')).status).toBe(200); // per user
  });
});

describe('customer FMCSA badge', () => {
  it('a customer whose snapshot holds only the profile (no watchlist check yet) shows "not checked", not a guess', async () => {
    const A2 = await registerUser();
    const stage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
    const mk = (name, snapshot) => prisma.carrier.create({ data: { ownerId: A2.user.id, stageId: stage.id, companyName: name, fmcsaSnapshot: JSON.stringify(snapshot), fmcsaCheckedAt: new Date() } });
    const onlyProfile = await mk('Profile Only Haulers', { profile: { dot: '1775913' } });
    const watched = await mk('Watched Haulers', { found: true, usdotStatus: 'active', carrierAuthority: 'active', profile: { dot: '1' } });
    for (const c of [onlyProfile, watched]) await prisma.customer.create({ data: { carrierId: c.id, ownerId: A2.user.id } });
    const res = await A2.agent.get('/api/customers');
    expect(res.status).toBe(200);
    const byCarrier = Object.fromEntries(res.body.items.map((c) => [c.carrierId, c.fmcsa]));
    expect(byCarrier[onlyProfile.id]).toBeNull();
    expect(byCarrier[watched.id]).toMatchObject({ found: true, authority: 'active' });
  });
});
