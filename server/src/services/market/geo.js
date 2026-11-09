/**
 * US state reference data for the market map and trip estimates.
 * Centroids are approximate geographic centers (public domain, US Census Bureau / USGS figures, rounded).
 * EIA regions follow the PADD definitions used by EIA's weekly retail diesel survey.
 */
export const STATES = {
  AL: ['Alabama', 32.79, -86.83, 'R30'], AK: ['Alaska', 64.73, -152.47, 'R5XCA'], AZ: ['Arizona', 34.29, -111.66, 'R5XCA'],
  AR: ['Arkansas', 34.89, -92.44, 'R30'], CA: ['California', 37.18, -119.47, 'SCA'], CO: ['Colorado', 38.99, -105.55, 'R40'],
  CT: ['Connecticut', 41.62, -72.73, 'R1X'], DE: ['Delaware', 38.99, -75.51, 'R1Y'], DC: ['District of Columbia', 38.9, -77.02, 'R1Y'],
  FL: ['Florida', 28.63, -82.45, 'R1Z'], GA: ['Georgia', 32.64, -83.44, 'R1Z'], HI: ['Hawaii', 20.29, -156.37, 'R5XCA'],
  ID: ['Idaho', 44.35, -114.61, 'R40'], IL: ['Illinois', 40.04, -89.2, 'R20'], IN: ['Indiana', 39.89, -86.28, 'R20'],
  IA: ['Iowa', 42.08, -93.5, 'R20'], KS: ['Kansas', 38.49, -98.38, 'R20'], KY: ['Kentucky', 37.53, -85.3, 'R20'],
  LA: ['Louisiana', 31.07, -92.0, 'R30'], ME: ['Maine', 45.37, -69.24, 'R1X'], MD: ['Maryland', 39.06, -76.8, 'R1Y'],
  MA: ['Massachusetts', 42.26, -71.81, 'R1X'], MI: ['Michigan', 44.35, -85.41, 'R20'], MN: ['Minnesota', 46.28, -94.31, 'R20'],
  MS: ['Mississippi', 32.74, -89.67, 'R30'], MO: ['Missouri', 38.36, -92.46, 'R20'], MT: ['Montana', 47.05, -109.63, 'R40'],
  NE: ['Nebraska', 41.54, -99.8, 'R20'], NV: ['Nevada', 39.33, -116.63, 'R5XCA'], NH: ['New Hampshire', 43.68, -71.58, 'R1X'],
  NJ: ['New Jersey', 40.19, -74.67, 'R1Y'], NM: ['New Mexico', 34.41, -106.11, 'R30'], NY: ['New York', 42.95, -75.53, 'R1Y'],
  NC: ['North Carolina', 35.56, -79.39, 'R1Z'], ND: ['North Dakota', 47.45, -100.47, 'R20'], OH: ['Ohio', 40.29, -82.79, 'R20'],
  OK: ['Oklahoma', 35.59, -97.49, 'R20'], OR: ['Oregon', 43.93, -120.56, 'R5XCA'], PA: ['Pennsylvania', 40.88, -77.8, 'R1Y'],
  RI: ['Rhode Island', 41.68, -71.56, 'R1X'], SC: ['South Carolina', 33.92, -80.9, 'R1Z'], SD: ['South Dakota', 44.44, -100.23, 'R20'],
  TN: ['Tennessee', 35.86, -86.35, 'R20'], TX: ['Texas', 31.48, -99.33, 'R30'], UT: ['Utah', 39.31, -111.67, 'R40'],
  VT: ['Vermont', 44.07, -72.67, 'R1X'], VA: ['Virginia', 37.52, -78.85, 'R1Z'], WA: ['Washington', 47.38, -120.45, 'R5XCA'],
  WV: ['West Virginia', 38.64, -80.62, 'R1Z'], WI: ['Wisconsin', 44.62, -89.99, 'R20'], WY: ['Wyoming', 43.0, -107.55, 'R40'],
};

export const EIA_REGIONS = {
  NUS: 'U.S. average', R1X: 'New England', R1Y: 'Central Atlantic', R1Z: 'Lower Atlantic', R20: 'Midwest',
  R30: 'Gulf Coast', R40: 'Rocky Mountain', R50: 'West Coast', R5XCA: 'West Coast except California', SCA: 'California',
};

const NAME_TO_CODE = Object.fromEntries(Object.entries(STATES).map(([code, [name]]) => [name.toLowerCase(), code]));

/** "Dallas, TX" / "TX" / "Texas" -> state code, or null. */
export function stateOf(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const tail = s.split(',').pop().trim();
  const two = tail.match(/\b([A-Za-z]{2})\b(?:\s+\d{5})?$/);
  if (two && STATES[two[1].toUpperCase()]) return two[1].toUpperCase();
  if (STATES[s.toUpperCase()]) return s.toUpperCase();
  return NAME_TO_CODE[tail.toLowerCase()] || NAME_TO_CODE[s.toLowerCase()] || null;
}

export function regionForState(state) {
  return STATES[state]?.[3] || null;
}

/** Great-circle distance in miles. */
export function haversineMiles(a, b) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const ROAD_FACTOR = 1.18;

/** Major freight cities (approximate city-center coordinates, public geographic facts). Key: "city, st" lowercase. */
const CITY_LIST = `Atlanta,GA,33.749,-84.388;Savannah,GA,32.081,-81.091;Dallas,TX,32.777,-96.797;Fort Worth,TX,32.755,-97.331;Houston,TX,29.760,-95.370;
San Antonio,TX,29.424,-98.494;Austin,TX,30.267,-97.743;El Paso,TX,31.762,-106.485;Laredo,TX,27.506,-99.507;Amarillo,TX,35.222,-101.831;
Los Angeles,CA,34.052,-118.244;Ontario,CA,34.063,-117.651;Fresno,CA,36.738,-119.787;Sacramento,CA,38.582,-121.494;Oakland,CA,37.804,-122.271;
San Diego,CA,32.716,-117.161;Stockton,CA,37.958,-121.291;Phoenix,AZ,33.448,-112.074;Tucson,AZ,32.222,-110.975;Las Vegas,NV,36.170,-115.140;
Reno,NV,39.530,-119.814;Salt Lake City,UT,40.761,-111.891;Denver,CO,39.739,-104.990;Albuquerque,NM,35.084,-106.651;Seattle,WA,47.606,-122.332;
Tacoma,WA,47.253,-122.444;Spokane,WA,47.659,-117.426;Portland,OR,45.515,-122.679;Boise,ID,43.615,-116.202;Billings,MT,45.783,-108.501;
Chicago,IL,41.878,-87.630;Joliet,IL,41.525,-88.082;Indianapolis,IN,39.768,-86.158;Columbus,OH,39.961,-82.999;Cleveland,OH,41.499,-81.694;
Cincinnati,OH,39.103,-84.512;Toledo,OH,41.654,-83.537;Detroit,MI,42.331,-83.046;Grand Rapids,MI,42.963,-85.668;Milwaukee,WI,43.039,-87.906;
Minneapolis,MN,44.978,-93.265;Des Moines,IA,41.587,-93.625;Omaha,NE,41.257,-95.935;Kansas City,MO,39.100,-94.579;St. Louis,MO,38.627,-90.199;
Wichita,KS,37.687,-97.330;Oklahoma City,OK,35.468,-97.516;Tulsa,OK,36.154,-95.993;Little Rock,AR,34.746,-92.290;Memphis,TN,35.150,-90.049;
Nashville,TN,36.163,-86.781;Knoxville,TN,35.961,-83.921;Chattanooga,TN,35.046,-85.309;Louisville,KY,38.253,-85.759;Lexington,KY,38.041,-84.504;
Birmingham,AL,33.519,-86.810;Mobile,AL,30.695,-88.040;Jackson,MS,32.299,-90.185;New Orleans,LA,29.951,-90.072;Baton Rouge,LA,30.451,-91.187;
Shreveport,LA,32.525,-93.750;Jacksonville,FL,30.332,-81.656;Miami,FL,25.762,-80.192;Orlando,FL,28.538,-81.379;Tampa,FL,27.951,-82.457;
Charlotte,NC,35.227,-80.843;Raleigh,NC,35.780,-78.639;Greensboro,NC,36.073,-79.792;Charleston,SC,32.777,-79.931;Columbia,SC,34.001,-81.035;
Greenville,SC,34.853,-82.394;Richmond,VA,37.541,-77.436;Norfolk,VA,36.851,-76.286;Baltimore,MD,39.290,-76.612;Washington,DC,38.907,-77.037;
Philadelphia,PA,39.953,-75.165;Pittsburgh,PA,40.441,-79.996;Harrisburg,PA,40.274,-76.884;Allentown,PA,40.608,-75.490;Newark,NJ,40.736,-74.172;
Elizabeth,NJ,40.664,-74.211;New York,NY,40.713,-74.006;Buffalo,NY,42.886,-78.878;Albany,NY,42.653,-73.756;Syracuse,NY,43.049,-76.147;
Boston,MA,42.360,-71.059;Springfield,MA,42.101,-72.590;Worcester,MA,42.263,-71.802;Hartford,CT,41.764,-72.685;Providence,RI,41.824,-71.413;
Portland,ME,43.659,-70.257;Manchester,NH,42.996,-71.455;Burlington,VT,44.476,-73.212;Wilmington,DE,39.740,-75.540;Charleston,WV,38.350,-81.633;
Fargo,ND,46.877,-96.790;Sioux Falls,SD,43.545,-96.731;Cheyenne,WY,41.140,-104.820;Anchorage,AK,61.218,-149.900;Honolulu,HI,21.307,-157.858`;
export const CITIES = Object.fromEntries(CITY_LIST.split(';').map((r) => r.trim()).filter(Boolean).map((r) => {
  const [city, st, lat, lon] = r.split(',');
  return [`${city.toLowerCase()}, ${st.toLowerCase()}`, [Number(lat), Number(lon)]];
}));

/** Coordinates for a place: a known city when "City, ST" matches, otherwise the state center. */
export function locate(input) {
  const state = stateOf(input);
  if (!state) return null;
  const city = String(input).split(',')[0].trim().toLowerCase();
  const hit = CITIES[`${city}, ${state.toLowerCase()}`];
  if (hit) return { state, lat: hit[0], lon: hit[1], precision: 'city' };
  const s = STATES[state];
  return { state, lat: s[1], lon: s[2], precision: 'state' };
}
