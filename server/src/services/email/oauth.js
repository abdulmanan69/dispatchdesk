import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { getSettings } from '../../lib/settings.js';
import { encrypt, decrypt } from '../../lib/crypto.js';

/**
 * OAuth2 provider definitions for mailbox connections.
 * Tokens are stored AES-GCM encrypted (refresh token in secretEnc, access token in accessTokenEnc).
 */
export const OAUTH_PROVIDERS = {
  gmail: {
    settings: ['google.clientId', 'google.clientSecret'],
    authorizeUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    scope: 'openid email https://www.googleapis.com/auth/gmail.send',
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    profileUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    profileEmail: (p) => p.email,
    profileName: (p) => p.name,
  },
  outlook: {
    settings: ['microsoft.clientId', 'microsoft.clientSecret'],
    authorizeUrl: (tenant) => `https://login.microsoftonline.com/${tenant || 'common'}/oauth2/v2.0/authorize`,
    tokenUrl: (tenant) => `https://login.microsoftonline.com/${tenant || 'common'}/oauth2/v2.0/token`,
    scope: 'offline_access openid email User.Read Mail.Send',
    extraAuthParams: { response_mode: 'query', prompt: 'select_account' },
    profileUrl: 'https://graph.microsoft.com/v1.0/me',
    profileEmail: (p) => p.mail || p.userPrincipalName,
    profileName: (p) => p.displayName,
  },
};

export const redirectUri = (provider) => `${config.appUrl}/api/email/oauth/${provider}/callback`;

async function credentials(provider) {
  const def = OAUTH_PROVIDERS[provider];
  const keys = [...def.settings, 'microsoft.tenant'];
  const s = await getSettings(keys);
  const [idKey, secretKey] = def.settings;
  return { clientId: s[idKey], clientSecret: s[secretKey], tenant: s['microsoft.tenant'] || 'common', missing: def.settings.filter((k) => !s[k]) };
}

export async function oauthAvailability() {
  const out = {};
  for (const p of Object.keys(OAUTH_PROVIDERS)) out[p] = (await credentials(p)).missing.length === 0;
  return out;
}

export async function buildAuthUrl(provider, state) {
  const def = OAUTH_PROVIDERS[provider];
  const c = await credentials(provider);
  if (c.missing.length) return { missing: c.missing };
  const params = new URLSearchParams({
    client_id: c.clientId, redirect_uri: redirectUri(provider), response_type: 'code', scope: def.scope, state, ...def.extraAuthParams,
  });
  return { url: `${def.authorizeUrl(c.tenant)}?${params}` };
}

async function tokenRequest(provider, body) {
  const def = OAUTH_PROVIDERS[provider];
  const c = await credentials(provider);
  if (c.missing.length) throw new Error(`OAuth not configured: missing ${c.missing.join(', ')}`);
  const res = await fetch(def.tokenUrl(c.tenant), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Token request failed: ${data.error_description || data.error || res.status}`);
  return data;
}

/** Exchange an authorization code; returns tokens + mailbox profile. */
export async function exchangeCode(provider, code) {
  const def = OAUTH_PROVIDERS[provider];
  const tok = await tokenRequest(provider, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(provider) });
  const pr = await fetch(def.profileUrl, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  const profile = await pr.json().catch(() => ({}));
  if (!pr.ok) throw new Error('Could not read mailbox profile');
  const email = def.profileEmail(profile);
  if (!email) throw new Error('Provider did not return an email address');
  return {
    email: String(email).toLowerCase(),
    name: def.profileName(profile) || null,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || null,
    expiresAt: new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000),
  };
}

/** Return a valid access token, refreshing (and persisting) when expired. */
export async function getAccessToken(account) {
  if (account.accessTokenEnc && account.tokenExpiresAt && account.tokenExpiresAt.getTime() > Date.now() + 60000) {
    return decrypt(account.accessTokenEnc);
  }
  const refreshToken = decrypt(account.secretEnc);
  if (!refreshToken) throw new Error('Mailbox authorization expired — reconnect the mailbox');
  const tok = await tokenRequest(account.provider, { grant_type: 'refresh_token', refresh_token: refreshToken });
  const expiresAt = new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000);
  await prisma.emailAccount.update({
    where: { id: account.id },
    data: {
      accessTokenEnc: encrypt(tok.access_token),
      tokenExpiresAt: expiresAt,
      ...(tok.refresh_token ? { secretEnc: encrypt(tok.refresh_token) } : {}),
    },
  });
  account.tokenExpiresAt = expiresAt;
  return tok.access_token;
}

/**
 * Check the OAuth client registration without a user: exchange a deliberately invalid code.
 * A valid client gets "invalid_grant" (bad code); a wrong client ID/secret gets "invalid_client" or an AADSTS client error.
 */
export async function checkOAuthClient(provider, fetchImpl = globalThis.fetch) {
  const def = OAUTH_PROVIDERS[provider];
  const c = await credentials(provider);
  const name = provider === 'gmail' ? 'Google' : 'Microsoft';
  if (c.missing.length) return { ok: false, message: `${name} client ID and secret are not set` };
  const notes = [];
  if (!/^https:\/\//.test(config.appUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(config.appUrl)) {
    notes.push(`APP_URL (${config.appUrl}) must be HTTPS for ${name} to accept the redirect URI.`);
  }
  let res;
  try {
    res = await fetchImpl(def.tokenUrl(c.tenant), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'authorization_code', code: 'dispatchdesk-configuration-check', redirect_uri: redirectUri(provider) }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    return { ok: false, message: `${name} token endpoint unreachable: ${err.message}` };
  }
  const data = await res.json().catch(() => ({}));
  const err = String(data.error || '');
  const desc = String(data.error_description || '');
  const clientBad = err === 'invalid_client' || err === 'unauthorized_client' || /AADSTS(700016|7000215|7000222|90002)/.test(desc);
  if (clientBad) return { ok: false, message: `${name} rejected the client ID or secret: ${(desc || err).split('\n')[0].slice(0, 200)}` };
  if (err === 'invalid_grant' || /AADSTS(9002313|70000|54005)/.test(desc)) {
    return { ok: true, message: [`${name} accepted the client credentials. Make sure ${redirectUri(provider)} is registered as a redirect URI.`, ...notes].join(' ') };
  }
  return { ok: false, message: `${name} responded ${res.status}: ${(desc || err || 'unexpected response').split('\n')[0].slice(0, 200)}` };
}
