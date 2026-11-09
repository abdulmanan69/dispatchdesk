import { normEquipment, normAuthority, intOrNull, dateOrNull } from './normalize.js';

/** Header aliases (lower-cased, non-alphanumerics stripped) → carrier field. */
const ALIASES = {
  companyName: ['companyname', 'company', 'legalname', 'carriername', 'name', 'carrier', 'businessname'],
  dbaName: ['dbaname', 'dba', 'doingbusinessas'],
  dotNumber: ['dotnumber', 'usdot', 'usdotnumber', 'dot', 'dotno', 'usdotno'],
  mcNumber: ['mcnumber', 'mc', 'mcno', 'docket', 'docketnumber', 'mcdocket'],
  phone: ['phone', 'phonenumber', 'telephone', 'tel', 'mobile', 'cell', 'contactphone'],
  email: ['email', 'emailaddress', 'mail', 'contactemail'],
  address: ['address', 'street', 'streetaddress', 'address1', 'physicaladdress', 'phystreet'],
  city: ['city', 'phycity'],
  state: ['state', 'st', 'phystate', 'province'],
  zip: ['zip', 'zipcode', 'postalcode', 'postal', 'phyzip'],
  equipment: ['equipment', 'equipmenttype', 'trailertype', 'trucktype', 'trailer'],
  fleetSize: ['fleetsize', 'powerunits', 'trucks', 'numberoftrucks', 'units', 'fleet'],
  drivers: ['drivers', 'totaldrivers', 'drivercount'],
  authorityStatus: ['authoritystatus', 'authority', 'status', 'operatingauthority'],
  authorityDate: ['authoritydate', 'authoritygranted', 'adddate', 'mcdate', 'granteddate'],
  contactName: ['contactname', 'contact', 'owner', 'ownername', 'firstname'],
  notes: ['notes', 'note', 'comments'],
};

const key = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Map CSV headers to fields. Returns { mapping: {header: field}, unmapped: [header] }. */
export function mapHeaders(headers) {
  const mapping = {};
  const used = new Set();
  const unmapped = [];
  for (const h of headers) {
    const k = key(h);
    const field = Object.entries(ALIASES).find(([f, al]) => !used.has(f) && al.includes(k))?.[0];
    if (field) { mapping[h] = field; used.add(field); } else unmapped.push(h);
  }
  return { mapping, unmapped };
}

/** Convert a parsed CSV row (object keyed by header) into carrier input. */
export function rowToCarrier(row, mapping) {
  const out = {};
  for (const [h, field] of Object.entries(mapping)) out[field] = row[h];
  return {
    companyName: out.companyName,
    dbaName: out.dbaName,
    dotNumber: out.dotNumber,
    mcNumber: out.mcNumber,
    phone: out.phone,
    email: out.email,
    address: out.address,
    city: out.city,
    state: out.state,
    zip: out.zip,
    equipment: normEquipment(out.equipment),
    fleetSize: intOrNull(out.fleetSize),
    drivers: intOrNull(out.drivers),
    authorityStatus: normAuthority(out.authorityStatus),
    authorityDate: dateOrNull(out.authorityDate),
    contactName: out.contactName ? String(out.contactName).trim().slice(0, 120) : null,
    notes: out.notes ? String(out.notes).trim().slice(0, 4000) : null,
  };
}

export const EXPORT_COLUMNS = [
  ['companyName', 'Company name'], ['dbaName', 'DBA'], ['dotNumber', 'USDOT'], ['mcNumber', 'MC'], ['phone', 'Phone'], ['email', 'Email'],
  ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['zip', 'ZIP'], ['equipment', 'Equipment'], ['fleetSize', 'Fleet size'],
  ['drivers', 'Drivers'], ['authorityStatus', 'Authority status'], ['authorityDate', 'Authority date'], ['stage', 'Stage'], ['tags', 'Tags'],
  ['source', 'Source'], ['doNotCall', 'Do not call'], ['doNotEmail', 'Do not email'], ['lastContactedAt', 'Last contacted'], ['createdAt', 'Created'],
];
