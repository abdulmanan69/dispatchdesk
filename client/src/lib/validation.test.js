import { describe, it, expect } from 'vitest';
import { authErrorMessage, emailError, fieldErrorsFrom, newPasswordError } from './validation.js';

describe('auth form checks', () => {
  it('checks the email', () => {
    expect(emailError('')).toBe('Enter your email address');
    expect(emailError('  ')).toBe('Enter your email address');
    expect(emailError('maya@')).toMatch(/^Enter a valid email address/);
    expect(emailError('maya@northline-dispatch.test')).toBe('');
  });

  it('checks a new password against the server rules', () => {
    expect(newPasswordError('')).toBe('Enter a password');
    expect(newPasswordError('abc1')).toBe('Password must be at least 8 characters');
    expect(newPasswordError('abcdefgh')).toBe('Password must include at least one letter and one number');
    expect(newPasswordError('12345678')).toBe('Password must include at least one letter and one number');
    expect(newPasswordError('haul2026')).toBe('');
  });

  it('maps server field errors to fields', () => {
    const err = { status: 400, details: [{ path: 'email', message: 'Enter your email address' }, { path: 'password', message: 'Enter your password' }] };
    expect(fieldErrorsFrom(err)).toEqual({ email: 'Enter your email address', password: 'Enter your password' });
    expect(fieldErrorsFrom({ status: 401, message: 'Incorrect email or password' })).toEqual({});
  });

  it('words network and rate-limit failures plainly', () => {
    expect(authErrorMessage({ network: true })).toMatch(/internet connection/);
    expect(authErrorMessage({ status: 429, message: 'Too many authentication attempts. Try again in 15 minutes.', retryAfterMs: 120_000 }))
      .toBe('Too many authentication attempts. Try again in 2 minutes.');
    expect(authErrorMessage({ status: 500, message: 'x' })).toMatch(/our side/);
    expect(authErrorMessage({ status: 401, message: 'Incorrect email or password' })).toBe('Incorrect email or password');
  });
});
