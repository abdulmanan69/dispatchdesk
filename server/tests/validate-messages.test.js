import { describe, it, expect } from 'vitest';
import { parse, z, reqEmail, reqStr, optEmail, optInt, fieldLabel } from '../src/lib/validate.js';

const msg = (schema, data) => {
  try { parse(schema, data); return null; } catch (e) { return { message: e.message, status: e.status, details: e.details }; }
};

describe('validation messages people read', () => {
  it('never shows Zod developer text such as ">=1 characters"', () => {
    const r = msg(z.object({ password: z.string().min(1) }), { password: '' });
    expect(r.status).toBe(400);
    expect(r.message).toBe('Password is required');
    expect(r.message).not.toMatch(/>=|Too small|expected/);
  });

  it('names the field and says what to do', () => {
    expect(msg(z.object({ email: reqEmail }), { email: '' }).message).toBe('Enter your email address');
    expect(msg(z.object({ email: reqEmail }), {}).message).toBe('Enter your email address');
    expect(msg(z.object({ email: reqEmail }), { email: 'bob@' }).message).toMatch(/^Enter a valid email address/);
    expect(msg(z.object({ billingEmail: optEmail }), { billingEmail: 'x' }).message).toBe('Billing email must be a valid email address');
    expect(msg(z.object({ name: reqStr(5) }), { name: '   ' }).message).toBe('Name is required');
    expect(msg(z.object({ name: reqStr(5) }), { name: 'abcdefgh' }).message).toBe('Name must be 5 characters or fewer');
    expect(msg(z.object({ status: z.enum(['new', 'won']) }), { status: 'x' }).message).toBe('Status must be one of: new, won');
    expect(msg(z.object({ usdot: z.coerce.number().int() }), { usdot: 'abc' }).message).toBe('USDOT number must be a number');
    expect(msg(z.object({ miles: optInt(1, 1e5) }), { miles: '200000' }).message).toBe('Miles must be 100,000 or less');
  });

  it('shows money limits in dollars for cent fields', () => {
    expect(msg(z.object({ rateCents: optInt(1, 1e9) }), { rateCents: '0' }).message).toBe('Rate must be at least $0.01');
  });

  it('keeps messages a schema wrote itself, and expands a bare "Required"', () => {
    expect(msg(z.object({ phone: z.string().min(1, 'Enter the phone number') }), { phone: '' }).message).toBe('Enter the phone number');
    expect(msg(z.object({ body: z.string().trim().min(1, 'Required') }), { body: '' }).message).toBe('Body is required');
  });

  it('lists every problem with its field path for forms', () => {
    const r = msg(z.object({ email: reqEmail, name: reqStr() }), { email: '', name: '' });
    expect(r.details).toEqual([
      { path: 'email', message: 'Enter your email address' },
      { path: 'name', message: 'Name is required' },
    ]);
  });

  it('labels nested and camelCase fields', () => {
    expect(fieldLabel(['stops', 0, 'city'])).toBe('City (item 1)');
    expect(fieldLabel(['carrierId'])).toBe('Carrier');
    expect(fieldLabel(['newPassword'])).toBe('New password');
    expect(fieldLabel([])).toBe('This field');
  });
});
