import { timezoneForState } from '../../lib/timezones.js';

/**
 * Facility time zone from city and state, offline.
 * lib/timezones.js maps each state to its majority zone, which is wrong for split states. The tables below cover the
 * freight cities on the minority side of a zone line (El Paso TX, the Florida panhandle, East Tennessee, West
 * Kentucky, NW/SW Indiana, Michigan's western Upper Peninsula, the western Dakotas/Nebraska/Kansas, eastern Oregon,
 * northern Idaho). Anything else falls back to the state's zone. Returns an IANA zone or null.
 */
const SPLIT = {
  TX: { zone: 'America/Denver', cities: ['el paso', 'anthony', 'canutillo', 'socorro', 'horizon city', 'fabens', 'clint', 'vinton', 'santa teresa', 'sierra blanca', 'fort hancock', 'dell city'] },
  FL: {
    zone: 'America/Chicago',
    cities: ['pensacola', 'panama city', 'panama city beach', 'fort walton beach', 'ft walton beach', 'destin', 'crestview', 'niceville', 'navarre', 'milton', 'gulf breeze',
      'marianna', 'chipley', 'defuniak springs', 'de funiak springs', 'bonifay', 'lynn haven', 'callaway', 'pace', 'cantonment', 'century', 'freeport', 'graceville',
      'santa rosa beach', 'miramar beach', 'mary esther', 'baker', 'jay', 'vernon', 'malone', 'sneads', 'cottondale', 'youngstown'],
  },
  TN: {
    zone: 'America/New_York',
    cities: ['knoxville', 'chattanooga', 'johnson city', 'kingsport', 'bristol', 'morristown', 'cleveland', 'maryville', 'oak ridge', 'athens', 'greeneville',
      'elizabethton', 'sevierville', 'pigeon forge', 'gatlinburg', 'lenoir city', 'dandridge', 'jefferson city', 'alcoa', 'loudon', 'sweetwater', 'madisonville',
      'harriman', 'kingston', 'rockwood', 'newport', 'rogersville', 'tazewell', 'la follette', 'lafollette', 'jacksboro', 'clinton', 'dayton', 'ooltewah',
      'collegedale', 'east ridge', 'red bank', 'soddy daisy', 'piney flats', 'blountville', 'mosheim', 'white pine', 'kodak', 'seymour', 'powell', 'halls', 'farragut'],
  },
  KY: {
    zone: 'America/Chicago',
    cities: ['bowling green', 'paducah', 'owensboro', 'hopkinsville', 'henderson', 'murray', 'mayfield', 'glasgow', 'russellville', 'franklin', 'princeton',
      'central city', 'greenville', 'morgantown', 'leitchfield', 'calvert city', 'cadiz', 'marion', 'providence', 'sturgis', 'scottsville', 'tompkinsville',
      'columbia', 'oak grove', 'fort campbell', 'benton', 'fulton', 'hickman', 'clinton', 'wickliffe', 'smithland', 'eddyville', 'kuttawa', 'dawson springs',
      'madisonville', 'earlington', 'nortonville', 'morganfield', 'uniontown', 'hawesville', 'hartford', 'beaver dam', 'brownsville', 'munfordville', 'edmonton', 'burkesville'],
  },
  IN: {
    zone: 'America/Chicago',
    cities: ['gary', 'hammond', 'east chicago', 'merrillville', 'valparaiso', 'michigan city', 'portage', 'crown point', 'hobart', 'la porte', 'laporte',
      'schererville', 'munster', 'highland', 'griffith', 'chesterton', 'lowell', 'cedar lake', 'dyer', 'st john', 'saint john', 'whiting', 'lake station',
      'evansville', 'newburgh', 'mount vernon', 'mt vernon', 'princeton', 'boonville', 'tell city', 'rockport', 'poseyville', 'chandler', 'haubstadt', 'fort branch'],
  },
  MI: { zone: 'America/Chicago', cities: ['iron mountain', 'menominee', 'ironwood', 'iron river', 'kingsford', 'norway', 'crystal falls', 'bessemer', 'wakefield', 'stephenson'] },
  ND: { zone: 'America/Denver', cities: ['dickinson', 'beach', 'bowman', 'hettinger', 'belfield', 'medora', 'mott', 'new england', 'elgin', 'richardton', 'south heart', 'amidon', 'scranton'] },
  SD: {
    zone: 'America/Denver',
    cities: ['rapid city', 'spearfish', 'sturgis', 'belle fourche', 'lead', 'deadwood', 'custer', 'hot springs', 'box elder', 'philip', 'wall', 'kadoka', 'martin',
      'lemmon', 'hill city', 'keystone', 'newell', 'whitewood', 'faith', 'buffalo', 'edgemont', 'pine ridge'],
  },
  NE: {
    zone: 'America/Denver',
    cities: ['scottsbluff', 'gering', 'sidney', 'alliance', 'chadron', 'kimball', 'ogallala', 'bridgeport', 'mitchell', 'rushville', 'gordon', 'oshkosh', 'chappell',
      'benkelman', 'imperial', 'grant', 'crawford', 'hemingford', 'morrill', 'minatare', 'big springs', 'lodgepole', 'potter', 'harrison', 'hay springs'],
  },
  KS: { zone: 'America/Denver', cities: ['goodland', 'sharon springs', 'tribune', 'syracuse', 'kanorado', 'coolidge', 'wallace', 'weskan'] },
  OR: { zone: 'America/Boise', cities: ['ontario', 'nyssa', 'vale', 'jordan valley', 'adrian'] },
  ID: {
    zone: 'America/Los_Angeles',
    cities: ["coeur d'alene", 'coeur dalene', 'lewiston', 'moscow', 'post falls', 'sandpoint', 'hayden', 'rathdrum', 'bonners ferry', 'kellogg', 'wallace',
      'grangeville', 'orofino', 'st maries', 'saint maries', 'priest river', 'spirit lake', 'plummer', 'kamiah', 'kooskia', 'potlatch', 'genesee', 'craigmont'],
  },
  NV: { zone: 'America/Denver', cities: ['west wendover', 'jackpot', 'owyhee'] },
  OK: { zone: 'America/Denver', cities: ['kenton'] },
};

const LOOKUP = new Map();
for (const [state, { zone, cities }] of Object.entries(SPLIT)) for (const c of cities) LOOKUP.set(`${state}|${c}`, zone);

export function normalizeCity(city) {
  return String(city || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\bft\b/g, 'fort')
    .replace(/\bmt\b/g, 'mount')
    .replace(/\s+/g, ' ')
    .trim();
}

/** IANA zone for a facility in `city`, `state` (null when the state is unknown). */
export function facilityTimezone(city, state) {
  const st = String(state || '').trim().toUpperCase();
  if (!st) return null;
  const c = normalizeCity(city);
  if (c) {
    const hit = LOOKUP.get(`${st}|${c}`) || LOOKUP.get(`${st}|${c.replace(/\bfort\b/g, 'ft')}`) || LOOKUP.get(`${st}|${c.replace(/\bsaint\b/g, 'st')}`);
    if (hit) return hit;
  }
  return timezoneForState(st);
}

/** True when `tz` is a zone this runtime knows. */
export function validTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
