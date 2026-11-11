import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { agent, registerUser, prisma } from './helpers.js';
import { setSetting } from '../src/lib/settings.js';
import { resetGoogleKeys, safeNextPath, GOOGLE_TOKEN_URL, GOOGLE_JWKS_URL } from '../src/services/auth/google.js';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const REDIRECT_URI = 'http://localhost:3999/api/auth/google/callback';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signToken(claims, { key = privateKey, kid = 'test-kid', alg = 'RS256' } = {}) {
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64(claims);
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

// Mocked Google endpoints (the app reaches them with global fetch).
let tokenReply = null; // { status, body }
let lastTokenRequest = null;
let jwksCalls = 0;
let fetchSpy;

let n = 0;
function identity() {
  n += 1;
  return { sub: `g-${Date.now()}-${n}`, email: `google${Date.now()}${n}@example.test` };
}

function claimsFor(nonce, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, email_verified: true,
    name: 'Gina Google', nonce, iat: now, exp: now + 3600, ...overrides,
  };
}

/** Start a sign-in: returns the agent plus the state/nonce/challenge sent to Google. */
async function begin(query = '?mode=login') {
  const a = await agent();
  const res = await a.get(`/api/auth/google/start${query}`);
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.location);
  return { a, res, loc, state: loc.searchParams.get('state'), nonce: loc.searchParams.get('nonce'), challenge: loc.searchParams.get('code_challenge') };
}

/** Finish a sign-in: Google's token endpoint returns `token` (or a token built from claims). */
async function finish(flow, { claims, token, query } = {}) {
  tokenReply = { status: 200, body: { access_token: 'at', token_type: 'Bearer', expires_in: 3599, id_token: token ?? signToken(claimsFor(flow.nonce, claims)) } };
  return flow.a.get(`/api/auth/google/callback${query ?? `?state=${encodeURIComponent(flow.state)}&code=auth-code-1`}`);
}

const sessionCookieSet = (res) => (res.headers['set-cookie'] || []).some((c) => c.startsWith('dd_session=') && !/dd_session=;/.test(c));
const reasonOf = (res) => {
  expect(res.status).toBe(302);
  const u = new URL(res.headers.location, 'http://x');
  expect(u.pathname).toBe('/login');
  expect(u.searchParams.get('error')).toBe('google');
  return u.searchParams.get('reason');
};

async function expectRefused(flow, res, reason) {
  expect(reasonOf(res)).toBe(reason);
  expect(sessionCookieSet(res)).toBe(false);
  expect((await flow.a.get('/api/auth/me')).body.user).toBeNull();
}

beforeAll(async () => {
  resetGoogleKeys();
  const realFetch = globalThis.fetch;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts = {}) => {
    const u = String(url);
    if (u === GOOGLE_TOKEN_URL) {
      lastTokenRequest = Object.fromEntries(new URLSearchParams(String(opts.body)));
      return new Response(JSON.stringify(tokenReply.body), { status: tokenReply.status, headers: { 'Content-Type': 'application/json' } });
    }
    if (u === GOOGLE_JWKS_URL) {
      jwksCalls += 1;
      return new Response(JSON.stringify({ keys: [JWK] }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=21600, must-revalidate' } });
    }
    return realFetch(url, opts);
  });
});

afterAll(async () => {
  fetchSpy?.mockRestore();
  await setSetting('google.clientId', '');
  await setSetting('google.clientSecret', '');
  await setSetting('app.registrationOpen', 'true');
});

describe('Google sign-in configuration', () => {
  it('reports the provider only when the client id and secret are set', async () => {
    await setSetting('google.clientId', '');
    await setSetting('google.clientSecret', '');
    const a = await agent();
    expect((await a.get('/api/auth/providers')).body).toEqual({ google: false });
    const start = await a.get('/api/auth/google/start?mode=login');
    expect(reasonOf(start)).toBe('not_configured');

    await setSetting('google.clientId', CLIENT_ID);
    expect((await a.get('/api/auth/providers')).body).toEqual({ google: false });
    await setSetting('google.clientSecret', 'test-secret');
    expect((await a.get('/api/auth/providers')).body).toEqual({ google: true });
  });
});

describe('Google sign-in flow', () => {
  beforeEach(async () => {
    await setSetting('google.clientId', CLIENT_ID);
    await setSetting('google.clientSecret', 'test-secret');
    await setSetting('app.registrationOpen', 'true');
    tokenReply = null;
    lastTokenRequest = null;
  });

  it('start sets a short-lived httpOnly cookie and redirects to Google with PKCE', async () => {
    const { res, loc } = await begin('?mode=register&next=%2Fapp%2Floads%3Ftab%3Dopen');
    expect(`${loc.origin}${loc.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = loc.searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')).toBe('openid email profile');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('state').length).toBeGreaterThanOrEqual(32);
    expect(p.get('nonce').length).toBeGreaterThanOrEqual(32);
    expect(p.get('access_type')).toBeNull();
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('dd_google_auth='));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/auth\/google/);
    expect(cookie).toMatch(/Max-Age=600/);
    // The cookie is sealed: neither the state nor the PKCE verifier is readable in it.
    expect(cookie).not.toContain(p.get('state'));
  });

  it('creates a new verified account, sends the PKCE verifier and returns to next', async () => {
    const id = identity();
    const flow = await begin('?mode=register&next=%2Fapp%2Floads%3Ftab%3Dopen');
    const res = await finish(flow, { claims: { ...id, email: id.email.toUpperCase() } });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app/loads?tab=open');
    expect(sessionCookieSet(res)).toBe(true);
    expect(crypto.createHash('sha256').update(lastTokenRequest.code_verifier).digest('base64url')).toBe(flow.challenge);
    expect(lastTokenRequest).toMatchObject({ grant_type: 'authorization_code', code: 'auth-code-1', redirect_uri: REDIRECT_URI, client_id: CLIENT_ID });

    const me = (await flow.a.get('/api/auth/me')).body.user;
    expect(me.email).toBe(id.email);
    expect(me.name).toBe('Gina Google');
    expect(me.emailVerified).toBe(true);
    expect(me.role).toBe('dispatcher');
    const row = await prisma.user.findUnique({ where: { id: me.id } });
    expect(row.googleSub).toBe(id.sub);
    expect(row.passwordHash).not.toMatch(/^\$2/);
    const actions = (await prisma.auditLog.findMany({ where: { actorId: me.id } })).map((l) => [l.action, JSON.parse(l.details || '{}').method]);
    expect(actions).toEqual(expect.arrayContaining([['auth.register', 'google'], ['auth.login', 'google']]));

    // The attempt is single-use: the cookie was cleared, so replaying the callback fails.
    const replay = await flow.a.get(`/api/auth/google/callback?state=${encodeURIComponent(flow.state)}&code=auth-code-1`);
    expect(reasonOf(replay)).toBe('state');
  });

  it('sends a brand-new account to the welcome page by default', async () => {
    const flow = await begin('?mode=register');
    const res = await finish(flow, { claims: identity() });
    expect(res.headers.location).toBe('/app?welcome=1');
  });

  it('links an existing verified account with the same email (any letter case) and keeps its password', async () => {
    const { email, user } = await registerUser();
    const before = await prisma.user.update({ where: { id: user.id }, data: { email: email.replace('user', 'User'), emailVerifiedAt: new Date() } });
    const sub = `g-link-${Date.now()}`;
    const flow = await begin('?mode=login&next=%2Fapp%2Fcarriers');
    const res = await finish(flow, { claims: { sub, email: email.toLowerCase() } });
    expect(res.headers.location).toBe('/app/carriers');
    expect((await flow.a.get('/api/auth/me')).body.user.id).toBe(user.id);
    const row = await prisma.user.findUnique({ where: { id: user.id } });
    expect(row.googleSub).toBe(sub);
    expect(row.passwordHash).toBe(before.passwordHash);
    const linked = await prisma.auditLog.findFirst({ where: { actorId: user.id, action: 'auth.google_linked' } });
    expect(linked).toBeTruthy();
  });

  it('links an unverified account, verifies the email and revokes the old password and sessions', async () => {
    const { agent: old, email, password, user } = await registerUser();
    expect((await old.get('/api/auth/me')).body.user.emailVerified).toBe(false);
    const flow = await begin();
    const res = await finish(flow, { claims: { sub: `g-pre-${Date.now()}`, email } });
    expect(res.headers.location).toBe('/app');
    const me = (await flow.a.get('/api/auth/me')).body.user;
    expect(me.id).toBe(user.id);
    expect(me.emailVerified).toBe(true);
    expect((await old.get('/api/auth/me')).body.user).toBeNull();
    const pw = await agent();
    expect((await pw.post('/api/auth/login').send({ email, password })).status).toBe(401);
  });

  it('signs in by Google account id even when the Google email changed', async () => {
    const id = identity();
    const first = await begin();
    await finish(first, { claims: id });
    const userId = (await first.a.get('/api/auth/me')).body.user.id;
    const again = await begin();
    const res = await finish(again, { claims: { sub: id.sub, email: `renamed${Date.now()}@example.test` } });
    expect(res.headers.location).toBe('/app');
    expect((await again.a.get('/api/auth/me')).body.user.id).toBe(userId);
  });

  it('refuses a wrong or missing state', async () => {
    const flow = await begin();
    await expectRefused(flow, await finish(flow, { claims: identity(), query: '?state=forged&code=x' }), 'state');
    const noCookie = await agent();
    const res = await noCookie.get(`/api/auth/google/callback?state=${encodeURIComponent(flow.state)}&code=x`);
    expect(reasonOf(res)).toBe('state');
  });

  it('reports a cancelled consent screen', async () => {
    const flow = await begin();
    await expectRefused(flow, await flow.a.get(`/api/auth/google/callback?state=${encodeURIComponent(flow.state)}&error=access_denied`), 'cancelled');
  });

  it('refuses a token endpoint error', async () => {
    const flow = await begin();
    tokenReply = { status: 400, body: { error: 'invalid_grant' } };
    await expectRefused(flow, await flow.a.get(`/api/auth/google/callback?state=${encodeURIComponent(flow.state)}&code=x`), 'token');
  });

  it('refuses a token with the wrong nonce', async () => {
    const flow = await begin();
    await expectRefused(flow, await finish(flow, { claims: { ...identity(), nonce: 'another-nonce' } }), 'nonce');
  });

  it('refuses a token for another client', async () => {
    const flow = await begin();
    await expectRefused(flow, await finish(flow, { claims: { ...identity(), aud: 'someone-else.apps.googleusercontent.com' } }), 'audience');
  });

  it('refuses a token from another issuer', async () => {
    const flow = await begin();
    await expectRefused(flow, await finish(flow, { claims: { ...identity(), iss: 'https://evil.example' } }), 'issuer');
  });

  it('refuses an expired token', async () => {
    const flow = await begin();
    const now = Math.floor(Date.now() / 1000);
    await expectRefused(flow, await finish(flow, { claims: { ...identity(), iat: now - 7200, exp: now - 3600 } }), 'expired');
  });

  it('refuses a token signed with another key or algorithm', async () => {
    const flow = await begin();
    await expectRefused(flow, await finish(flow, { token: signToken(claimsFor(flow.nonce, identity()), { key: otherKey }) }), 'signature');
    const flow2 = await begin();
    const head = b64({ alg: 'none', kid: 'test-kid' });
    await expectRefused(flow2, await finish(flow2, { token: `${head}.${b64(claimsFor(flow2.nonce, identity()))}.e30` }), 'signature');
  });

  it('refuses an email Google has not verified', async () => {
    const flow = await begin();
    await expectRefused(flow, await finish(flow, { claims: { ...identity(), email_verified: false } }), 'unverified');
  });

  it('refuses a new account while registration is closed', async () => {
    const { email, user } = await registerUser();
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    await setSetting('app.registrationOpen', 'false');
    const id = identity();
    const flow = await begin('?mode=register');
    await expectRefused(flow, await finish(flow, { claims: id }), 'closed');
    expect(await prisma.user.findUnique({ where: { email: id.email } })).toBeNull();
    // Existing accounts can still sign in with Google.
    const flow2 = await begin();
    const ok = await finish(flow2, { claims: { sub: `g-closed-${Date.now()}`, email } });
    expect(ok.headers.location).toBe('/app');
  });

  it('refuses suspended accounts, found by email or by Google id', async () => {
    const { email, user } = await registerUser();
    await prisma.user.update({ where: { id: user.id }, data: { status: 'suspended', emailVerifiedAt: new Date() } });
    const flow = await begin();
    await expectRefused(flow, await finish(flow, { claims: { sub: `g-susp-${Date.now()}`, email } }), 'suspended');
    expect((await prisma.user.findUnique({ where: { id: user.id } })).googleSub).toBeNull();

    const id = identity();
    const first = await begin();
    await finish(first, { claims: id });
    await prisma.user.update({ where: { email: id.email }, data: { status: 'suspended' } });
    const again = await begin();
    await expectRefused(again, await finish(again, { claims: id }), 'suspended');
  });

  it('refuses an account already linked to a different Google account', async () => {
    const { email, user } = await registerUser();
    await prisma.user.update({ where: { id: user.id }, data: { googleSub: `g-other-${Date.now()}`, emailVerifiedAt: new Date() } });
    const flow = await begin();
    await expectRefused(flow, await finish(flow, { claims: { sub: `g-new-${Date.now()}`, email } }), 'linked_other');
  });

  it('caches Google signing keys for their max-age', async () => {
    resetGoogleKeys();
    const before = jwksCalls;
    for (let i = 0; i < 2; i += 1) {
      const flow = await begin();
      await finish(flow, { claims: identity() });
    }
    expect(jwksCalls - before).toBe(1);
  });
});

describe('next path validation', () => {
  it('ignores open-redirect attempts', async () => {
    for (const bad of ['//evil.example/x', 'https://evil.example', '/\\evil.example', '/.//evil.example', 'javascript:alert(1)', '/api/auth/logout', ' /app', '/app\n/x', '']) {
      expect(safeNextPath(bad)).toBe('/app');
    }
    expect(safeNextPath('/app/loads?tab=open#x')).toBe('/app/loads?tab=open#x');
    expect(safeNextPath('/community/post/1')).toBe('/community/post/1');
  });

  it('falls back to /app after sign-in when next points elsewhere', async () => {
    await setSetting('google.clientId', CLIENT_ID);
    await setSetting('google.clientSecret', 'test-secret');
    const flow = await begin(`?mode=login&next=${encodeURIComponent('//evil.example/steal')}`);
    const res = await finish(flow, { claims: identity() });
    expect(res.headers.location).toBe('/app?welcome=1');
    const flow2 = await begin(`?mode=login&next=${encodeURIComponent('https://evil.example')}`);
    const res2 = await finish(flow2, { claims: identity() });
    expect(res2.headers.location).toBe('/app?welcome=1');
  });
});

describe('unlinking Google', () => {
  beforeEach(async () => {
    await setSetting('google.clientId', CLIENT_ID);
    await setSetting('google.clientSecret', 'test-secret');
  });

  it('needs a password first for accounts created with Google', async () => {
    const flow = await begin();
    await finish(flow, { claims: identity() });
    expect((await flow.a.get('/api/auth/google/status')).body).toEqual({ linked: true, hasPassword: false, available: true });
    const res = await flow.a.post('/api/auth/google/unlink');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Set a password/);
  });

  it('unlinks when the account has a password', async () => {
    const { agent: a, user } = await registerUser();
    expect((await a.post('/api/auth/google/unlink')).status).toBe(400); // nothing linked yet
    await prisma.user.update({ where: { id: user.id }, data: { googleSub: `g-unlink-${Date.now()}` } });
    expect((await a.get('/api/auth/google/status')).body).toMatchObject({ linked: true, hasPassword: true });
    const res = await a.post('/api/auth/google/unlink');
    expect(res.status).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: user.id } })).googleSub).toBeNull();
    expect((await a.get('/api/auth/google/status')).body.linked).toBe(false);
  });

  it('requires a signed-in session', async () => {
    const a = await agent();
    expect((await a.post('/api/auth/google/unlink')).status).toBe(401);
    expect((await a.get('/api/auth/google/status')).status).toBe(401);
  });
});
