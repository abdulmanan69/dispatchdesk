/** US states: FIPS code (matches us-atlas feature ids), name, IANA time zone and zone group. */
const ROWS = `01 AL Alabama America/Chicago C;02 AK Alaska America/Anchorage AK;04 AZ Arizona America/Phoenix M;05 AR Arkansas America/Chicago C;
06 CA California America/Los_Angeles P;08 CO Colorado America/Denver M;09 CT Connecticut America/New_York E;10 DE Delaware America/New_York E;
11 DC District_of_Columbia America/New_York E;12 FL Florida America/New_York E;13 GA Georgia America/New_York E;15 HI Hawaii Pacific/Honolulu HI;
16 ID Idaho America/Boise M;17 IL Illinois America/Chicago C;18 IN Indiana America/Indiana/Indianapolis E;19 IA Iowa America/Chicago C;
20 KS Kansas America/Chicago C;21 KY Kentucky America/New_York E;22 LA Louisiana America/Chicago C;23 ME Maine America/New_York E;
24 MD Maryland America/New_York E;25 MA Massachusetts America/New_York E;26 MI Michigan America/Detroit E;27 MN Minnesota America/Chicago C;
28 MS Mississippi America/Chicago C;29 MO Missouri America/Chicago C;30 MT Montana America/Denver M;31 NE Nebraska America/Chicago C;
32 NV Nevada America/Los_Angeles P;33 NH New_Hampshire America/New_York E;34 NJ New_Jersey America/New_York E;35 NM New_Mexico America/Denver M;
36 NY New_York America/New_York E;37 NC North_Carolina America/New_York E;38 ND North_Dakota America/Chicago C;39 OH Ohio America/New_York E;
40 OK Oklahoma America/Chicago C;41 OR Oregon America/Los_Angeles P;42 PA Pennsylvania America/New_York E;44 RI Rhode_Island America/New_York E;
45 SC South_Carolina America/New_York E;46 SD South_Dakota America/Chicago C;47 TN Tennessee America/Chicago C;48 TX Texas America/Chicago C;
49 UT Utah America/Denver M;50 VT Vermont America/New_York E;51 VA Virginia America/New_York E;53 WA Washington America/Los_Angeles P;
54 WV West_Virginia America/New_York E;55 WI Wisconsin America/Chicago C;56 WY Wyoming America/Denver M`;

export const STATES = ROWS.split(';').map((r) => r.trim()).filter(Boolean).map((r) => {
  const [fips, code, name, tz, zone] = r.split(' ');
  return { fips, code, name: name.replace(/_/g, ' '), tz, zone };
});
export const BY_FIPS = Object.fromEntries(STATES.map((s) => [s.fips, s]));
export const BY_CODE = Object.fromEntries(STATES.map((s) => [s.code, s]));

/** Zone groups: quiet tints from one neutral-teal family, distinguishable but not a rainbow. */
export const ZONES = {
  E: { label: 'Eastern', fill: 'var(--map-e)' },
  C: { label: 'Central', fill: 'var(--map-c)' },
  M: { label: 'Mountain', fill: 'var(--map-m)' },
  P: { label: 'Pacific', fill: 'var(--map-p)' },
  AK: { label: 'Alaska', fill: 'var(--map-ak)' },
  HI: { label: 'Hawaii', fill: 'var(--map-ak)' },
};

export function localTime(tz, date = new Date()) {
  try { return date.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
}
