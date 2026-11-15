import { z } from 'zod';
import { badRequest } from './errors.js';

export { z };

// Readable validation messages. Zod's built-in English ("Too small: expected string to have >=1 characters") is written
// for developers; people see these in forms and toasts. Messages a schema sets itself are already written for people
// and are kept as they are; everything else gets a sentence that names the field.

const LABELS = {
  email: 'Email', password: 'Password', newPassword: 'New password', currentPassword: 'Current password',
  name: 'Name', phone: 'Phone number', acceptTerms: 'Terms', usdot: 'USDOT number', dot: 'USDOT number',
  dotNumber: 'USDOT number', mc: 'MC number', mcNumber: 'MC number', url: 'Web address', baseUrl: 'Base URL',
  apiKey: 'API key', zip: 'ZIP code', ein: 'EIN', token: 'Link',
};

/** "billingEmail" -> "Billing email", "carrierId" -> "Carrier", "stops.0.city" -> "City (item 1)". */
export function fieldLabel(path = []) {
  const keys = path.filter((p) => typeof p === 'string');
  const index = path.findLast?.((p) => typeof p === 'number');
  const key = keys[keys.length - 1];
  let label = 'This field';
  if (key) {
    label = LABELS[key] || key.replace(/(Cents|Id|Ids)$/, '').replace(/[_-]+/g, ' ')
      .replace(/([a-z\d])([A-Z])/g, '$1 $2').trim().toLowerCase();
    label = label ? label[0].toUpperCase() + label.slice(1) : 'This field';
  }
  return typeof index === 'number' ? `${label} (item ${index + 1})` : label;
}

const n = (v) => (typeof v === 'bigint' ? v.toString() : Number(v).toLocaleString('en-US'));
const isMissing = (iss) => iss.input === undefined && iss.received !== 'NaN' && iss.received !== 'Invalid Date';

/** One plain sentence for a Zod issue. */
export function issueMessage(iss) {
  const label = fieldLabel(iss.path);
  const thing = /^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label; // keeps "USDOT number"
  const isEmail = label === 'Email';
  // Money is stored in cents ("rateCents"); people type dollars.
  const cents = /Cents$/.test(String(iss.path?.filter((p) => typeof p === 'string').at(-1) || ''));
  const amount = (v) => (cents
    ? `$${(Number(v) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : n(v));
  switch (iss.code) {
    case 'invalid_type':
      if (isMissing(iss)) return isEmail ? 'Enter your email address' : `${label} is required`;
      if (iss.expected === 'number' || iss.expected === 'int' || iss.expected === 'bigint') return `${label} must be a number`;
      if (iss.expected === 'date') return `${label} must be a valid date`;
      if (iss.expected === 'boolean') return `${label} must be yes or no`;
      if (iss.expected === 'array') return `${label} must be a list`;
      if (iss.expected === 'string') return `${label} must be text`;
      return `${label} is not in the right format`;
    case 'too_small': {
      const min = iss.minimum;
      if (iss.origin === 'string') {
        if (Number(min) <= 1 || iss.input === '') return isEmail ? 'Enter your email address' : `${label} is required`;
        return `${label} must be at least ${n(min)} characters`;
      }
      if (iss.origin === 'array' || iss.origin === 'set') {
        return Number(min) <= 1 ? `${label} needs at least one entry` : `${label} needs at least ${n(min)} entries`;
      }
      if (iss.origin === 'date') return `${label} must be on or after ${new Date(Number(min)).toISOString().slice(0, 10)}`;
      if (iss.origin === 'file') return `${label} is empty`;
      return iss.inclusive === false ? `${label} must be more than ${amount(min)}` : `${label} must be at least ${amount(min)}`;
    }
    case 'too_big': {
      const max = iss.maximum;
      if (iss.origin === 'string') return `${label} must be ${n(max)} characters or fewer`;
      if (iss.origin === 'array' || iss.origin === 'set') return `${label} can have at most ${n(max)} entries`;
      if (iss.origin === 'date') return `${label} must be on or before ${new Date(Number(max)).toISOString().slice(0, 10)}`;
      if (iss.origin === 'file') return `${label} is too large`;
      return iss.inclusive === false ? `${label} must be less than ${amount(max)}` : `${label} must be ${amount(max)} or less`;
    }
    case 'invalid_format':
      if (iss.input === '') return isEmail ? 'Enter your email address' : `${label} is required`;
      if (iss.format === 'email') return isEmail ? 'Enter a valid email address, like name@company.com' : `${label} must be a valid email address`;
      if (iss.format === 'url') return `${label} must be a full web address, starting with https://`;
      if (iss.format === 'datetime' || iss.format === 'date' || iss.format === 'time') return `${label} must be a valid date`;
      return `${label} is not in the right format`;
    case 'invalid_value': {
      const values = iss.values || [];
      if (values.length === 1 && values[0] === true) return `Check the box to confirm ${thing}`;
      if (values.length && values.length <= 6 && values.every((v) => typeof v === 'string' || typeof v === 'number')) {
        return `${label} must be one of: ${values.join(', ')}`;
      }
      return `${label} is not a valid choice`;
    }
    case 'not_multiple_of': return `${label} must be a multiple of ${n(iss.divisor)}`;
    case 'unrecognized_keys': return `Unknown field${iss.keys?.length > 1 ? 's' : ''}: ${(iss.keys || []).join(', ')}`;
    case 'invalid_union': return `${label} is not in the right format`;
    case 'invalid_key':
    case 'invalid_element': return `${label} has an entry that is not valid`;
    default: return `${label} is not valid`;
  }
}

export function parse(schema, data) {
  const ours = new Set();
  const error = (iss) => { const m = issueMessage(iss); ours.add(m); return m; };
  const r = schema.safeParse(data ?? {}, { error });
  if (!r.success) {
    const issues = r.error.issues.map((i) => {
      // A schema's own short "Required" names the field; its full sentences stand as written.
      const message = !ours.has(i.message) && /^required$/i.test(i.message) ? `${fieldLabel(i.path)} is required` : i.message;
      return { path: i.path.join('.'), message };
    });
    throw badRequest(issues[0]?.message || 'Some of the details are not valid. Check the form and try again.', issues);
  }
  return r.data;
}

// Field helpers. Empty strings / explicit null become null (clear the column);
// a MISSING field stays undefined so partial updates leave the column untouched.
const emptyToNull = (v) => (v === '' || v === null ? null : v);
export const optStr = (max = 500) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());
export const reqStr = (max = 500) => z.string().trim().min(1, 'Required').max(max);
export const optEmail = z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim().toLowerCase()) : emptyToNull(v)),
  z.string().email().max(254).nullable().optional(),
);
export const reqEmail = z.string().trim().toLowerCase().email().max(254);
const num = (v) => (v === undefined ? undefined : v === '' || v === null ? null : Number(v));
export const optInt = (min = 0, max = 1e9) => z.preprocess(num, z.number().int().min(min).max(max).nullable().optional());
export const optNum = (min = 0, max = 1e9) => z.preprocess(num, z.number().min(min).max(max).nullable().optional());
export const optDate = z.preprocess((v) => (v === undefined ? undefined : v === '' || v === null ? null : new Date(v)), z.date().nullable().optional());
export const optBool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional());
export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
};

export const paginate = (q) => ({ skip: (q.page - 1) * q.pageSize, take: q.pageSize });
export const pageResult = (items, total, q) => ({
  items, total, page: q.page, pageSize: q.pageSize, pages: Math.max(1, Math.ceil(total / q.pageSize)),
});

/** Remove undefined keys so Prisma `update` leaves untouched columns alone. */
export const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
