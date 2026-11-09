import { z } from 'zod';
import { badRequest } from './errors.js';

export { z };

export function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest(issues[0] ? `${issues[0].path || 'input'}: ${issues[0].message}` : 'Invalid input', issues);
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
