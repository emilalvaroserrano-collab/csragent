import 'server-only';

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getAdminDb } from '@/lib/firebase-admin';

const ROOT = 'serverIntegrations/canva';
const API = 'https://api.canva.com/rest/v1';
const SUPPORTED_SCOPES = new Set([
  'asset:read', 'asset:write', 'brandtemplate:content:read', 'brandtemplate:content:write',
  'brandtemplate:meta:read', 'collaboration:event', 'comment:read', 'comment:write',
  'design:content:read', 'design:content:write', 'design:meta:read', 'email',
  'folder:permission:write', 'folder:read', 'folder:write', 'openid', 'profile', 'profile:read'
]);
export const CANVA_DEFAULT_SCOPES = [
  'asset:read', 'asset:write', 'brandtemplate:content:read', 'brandtemplate:meta:read',
  'design:content:read', 'design:content:write',
  'design:meta:read', 'folder:read', 'folder:write', 'profile:read'
];

export function config() {
  const previewComments = process.env.CANVA_ENABLE_PREVIEW_COMMENTS === 'true';
  const defaults = [...CANVA_DEFAULT_SCOPES, ...(previewComments ? ['comment:read', 'comment:write'] : [])];
  const scopes = (process.env.CANVA_SCOPES || defaults.join(' ')).trim().split(/\s+/).filter(Boolean);
  if (scopes.some(s => !SUPPORTED_SCOPES.has(s))) throw new Error('CANVA_SCOPES contains an unsupported Canva user scope.');
  return {
    clientId: process.env.CANVA_CLIENT_ID || '',
    clientSecret: process.env.CANVA_CLIENT_SECRET || '',
    redirectUri: process.env.CANVA_REDIRECT_URI || '',
    encryptionKey: process.env.CANVA_TOKEN_ENCRYPTION_KEY || '',
    signingSecret: process.env.CANVA_TOOL_SIGNING_SECRET || '',
    previewGeneration: process.env.CANVA_ENABLE_PREVIEW_GENERATION === 'true',
    previewComments,
    scopes,
    configured: Boolean(process.env.CANVA_CLIENT_ID && process.env.CANVA_CLIENT_SECRET &&
      (/^(https:\/\/[^\s/]+|http:\/\/localhost(?::\d+)?)\/api\/canva\/callback$/.test(process.env.CANVA_REDIRECT_URI || '')) &&
      /^[a-f0-9]{64}$/i.test(process.env.CANVA_TOKEN_ENCRYPTION_KEY || '') &&
      (process.env.CANVA_TOOL_SIGNING_SECRET || '').length >= 32)
  };
}
export function digest(input) { return createHash('sha256').update(String(input)).digest('hex'); }
function db() {
  const database = getAdminDb();
  if (!database) throw new Error('Firebase Admin database is not configured.');
  return database;
}
export function accountRef(uid) { return db().ref(`${ROOT}/accounts/${digest(uid)}`); }
export function stateRef(state) { return db().ref(`${ROOT}/oauthStates/${digest(state)}`); }
function refreshLockRef(uid) { return db().ref(`${ROOT}/refreshLocks/${digest(uid)}`); }
function key() { return Buffer.from(config().encryptionKey, 'hex'); }
export function encrypt(value) {
  if (!/^[a-f0-9]{64}$/i.test(config().encryptionKey)) throw new Error('CANVA_TOKEN_ENCRYPTION_KEY is invalid.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}
export function decrypt(ciphertext) {
  const [version, iv, tag, encrypted, extra] = String(ciphertext || '').split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted || extra !== undefined) throw new Error('Canva credentials are invalid. Reconnect Canva.');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}

export function createPkce() {
  const verifier = randomBytes(64).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
export function authorizeUrl({ state, challenge }) {
  const c = config();
  if (!c.configured) throw new Error('Canva is not configured on the server.');
  const url = new URL('https://www.canva.com/api/oauth/authorize');
  for (const [key, value] of Object.entries({
    response_type: 'code', client_id: c.clientId, redirect_uri: c.redirectUri,
    scope: c.scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256'
  })) url.searchParams.set(key, value);
  return url.toString();
}
function basicAuth() {
  const { clientId, clientSecret } = config();
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}
async function requestToken(body) {
  const response = await fetch(`${API}/oauth/token`, {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(18000),
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token || !result.refresh_token) {
    const error = new Error('Canva authorization failed or expired. Reconnect the account.');
    error.status = 401;
    throw error;
  }
  return result;
}
export async function exchangeCode(code, verifier) {
  return requestToken({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: config().redirectUri });
}
export function accountFromTokens(tokens, profile = {}) {
  if (!tokens.access_token || !tokens.refresh_token) throw new Error('Canva did not issue both OAuth tokens.');
  return {
    accessToken: encrypt(tokens.access_token), refreshToken: encrypt(tokens.refresh_token),
    expiresAt: Date.now() + Math.max(0, Number(tokens.expires_in) || 14400) * 1000,
    scopes: typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : [],
    profile: { name: String(profile?.display_name || '').slice(0, 120), id: String(profile?.user_id || '').slice(0, 120) },
    connectedAt: Date.now()
  };
}
export async function readAccount(uid) {
  const snap = await accountRef(uid).get();
  return snap.exists() ? snap.val() : null;
}
export function publicAccount(account) {
  return {
    connected: Boolean(account?.accessToken && account?.refreshToken),
    name: account?.profile?.name || '',
    scopes: Array.isArray(account?.scopes) ? account.scopes : [],
    connectedAt: account?.connectedAt || null
  };
}

// Canva refresh tokens rotate; a distributed RTDB lease prevents two serverless workers
// from spending the same refresh token concurrently. All account writes are transactional.
export async function accessToken(uid) {
  let account = await readAccount(uid);
  if (!account?.accessToken || !account?.refreshToken) throw new Error('Connect Canva first.');
  if (account.expiresAt - Date.now() > 90_000) return decrypt(account.accessToken);
  const lock = refreshLockRef(uid);
  const nonce = randomBytes(16).toString('hex');
  let acquired = false;
  for (let i = 0; i < 12; i++) {
    const tx = await lock.transaction(current => (!current || current.until < Date.now())
      ? { nonce, until: Date.now() + 30_000 } : undefined, undefined, false);
    if (tx.committed) { acquired = true; break; }
    await new Promise(resolve => setTimeout(resolve, 300));
    account = await readAccount(uid);
    if (!account) throw new Error('Canva was disconnected.');
    if (account.expiresAt - Date.now() > 90_000) return decrypt(account.accessToken);
  }
  if (!acquired) throw new Error('Canva token refresh is busy; retry in a moment.');
  try {
    account = await readAccount(uid);
    if (!account) throw new Error('Canva was disconnected.');
    if (account.expiresAt - Date.now() > 90_000) return decrypt(account.accessToken);
    const oldRefresh = account.refreshToken;
    const tokens = await requestToken({ grant_type: 'refresh_token', refresh_token: decrypt(oldRefresh) });
    const updated = {
      accessToken: encrypt(tokens.access_token), refreshToken: encrypt(tokens.refresh_token),
      expiresAt: Date.now() + Math.max(0, Number(tokens.expires_in) || 14400) * 1000,
      scopes: typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : account.scopes
    };
    const tx = await accountRef(uid).transaction(current => current?.refreshToken === oldRefresh
      ? { ...current, ...updated } : undefined, undefined, false);
    if (!tx.committed) throw new Error('Canva authorization changed; retry.');
    return tokens.access_token;
  } finally {
    await lock.transaction(current => current?.nonce === nonce ? null : undefined, undefined, false).catch(() => {});
  }
}

export async function canvaApi(uid, path, { method = 'GET', query = {}, body } = {}) {
  // Paths are constructed by named operation functions; never accept arbitrary user-provided API paths.
  const token = await accessToken(uid);
  const url = new URL(`${API}/${path.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '' && value !== null) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method, cache: 'no-store', signal: AbortSignal.timeout(25000),
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const safeCodes = {
      missing_scope: 'Canva permission missing. Enable the scope in Canva Developer Portal and reconnect.',
      permission_denied: 'Your Canva account cannot access this resource or action.',
      invalid_access_token: 'Canva authorization expired. Reconnect.',
      revoked_access_token: 'Canva access was revoked. Reconnect.',
      rate_limit_exceeded: 'Canva rate limit reached; retry later.',
      credit_quota_exceeded: 'Your Canva AI credit allowance has been reached.',
      app_credit_quota_exceeded: 'The Canva application has reached its AI credit allowance.'
    };
    const error = new Error(safeCodes[data.code] || `Canva API request failed (${response.status}; ${String(data.code || 'api_error').slice(0, 48)}).`);
    error.status = [400, 401, 403, 404, 409, 429].includes(response.status) ? response.status : 502;
    throw error;
  }
  return data;
}
export async function getProfileWithToken(token) {
  const response = await fetch(`${API}/users/me/profile`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) return {};
  const data = await response.json().catch(() => ({}));
  return data.profile || {};
}
export async function revoke(uid) {
  const account = await readAccount(uid);
  if (!account) return;
  // Remove local authorization before best-effort upstream revocation to prevent agent reuse.
  await accountRef(uid).remove();
  await refreshLockRef(uid).remove();
  try {
    const response = await fetch(`${API}/oauth/revoke`, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(12000),
      headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: decrypt(account.refreshToken) })
    });
    if (!response.ok) console.error('Canva upstream revocation unavailable:', response.status);
  } catch { console.error('Canva upstream revocation unavailable.'); }
}

export function issueToolToken(uid, now = Date.now()) {
  const expires = Math.floor(now / 1000) + 60 * 90;
  const payload = Buffer.from(JSON.stringify({ uid, exp: expires })).toString('base64url');
  const sig = createHmac('sha256', config().signingSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
export function verifyToolToken(value, now = Date.now()) {
  const [payload, signature, extra] = String(value || '').split('.');
  if (!payload || !signature || extra !== undefined || !config().configured || value.length > 2000) return '';
  const expected = createHmac('sha256', config().signingSecret).update(payload).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return ''; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return '';
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return (typeof data.uid === 'string' && data.uid.length < 130 && Number.isInteger(data.exp) &&
      data.exp > Math.floor(now / 1000) && data.exp <= Math.floor(now / 1000) + 5400) ? data.uid : '';
  } catch { return ''; }
}
