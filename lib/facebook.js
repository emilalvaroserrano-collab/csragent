import 'server-only';

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { getAdminDb } from '@/lib/firebase-admin';

// Pin this to a version supported by the Meta app, rather than silently using an unversioned endpoint.
const VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v27.0';
const BASE = `https://graph.facebook.com/${VERSION}`;
const ROOT = 'serverIntegrations/facebook';
export const FACEBOOK_SCOPES = [
  'pages_show_list', 'pages_read_engagement',
  'pages_manage_posts', 'pages_manage_metadata', 'pages_messaging'
];

export function config() {
  return {
    appId: process.env.FACEBOOK_APP_ID || '',
    appSecret: process.env.FACEBOOK_APP_SECRET || '',
    redirectUri: process.env.FACEBOOK_REDIRECT_URI || '',
    loginConfigId: process.env.FACEBOOK_LOGIN_CONFIG_ID || '',
    webhookVerifyToken: process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN || '',
    encryptionKey: process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY || '',
    configured: Boolean(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET &&
      process.env.FACEBOOK_REDIRECT_URI && /^[0-9a-f]{64}$/i.test(process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY || ''))
  };
}

export function database() {
  const db = getAdminDb();
  if (!db) throw new Error('Firebase Admin database not configured.');
  return db;
}

export function accountRef(uid) { return database().ref(`${ROOT}/accounts/${uid}`); }
export function pageOwnerRef(pageId) { return database().ref(`${ROOT}/pageOwners/${pageId}`); }
export function oauthStateRef(digest) { return database().ref(`${ROOT}/oauthStates/${digest}`); }
export function conversationRef(uid, pageId, senderId) {
  return database().ref(`${ROOT}/conversations/${uid}/${pageId}/${sha256(senderId)}`);
}
export function webhookJobRef(pageId, messageId) {
  return database().ref(`${ROOT}/webhookJobs/${pageId}/${sha256(messageId)}`);
}
export function deliveryRef(pageId, messageId) {
  return database().ref(`${ROOT}/deliveries/${pageId}/${sha256(messageId)}`);
}
export function sha256(value) { return createHash('sha256').update(String(value)).digest('hex'); }

function keyBytes() {
  const raw = config().encryptionKey;
  if (!/^[0-9a-f]{64}$/i.test(raw)) throw new Error('FACEBOOK_TOKEN_ENCRYPTION_KEY must be 64 hex characters.');
  return Buffer.from(raw, 'hex');
}
export function encryptToken(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(), iv);
  const data = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}
export function decryptToken(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Facebook credential is not usable. Reconnect Facebook.');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(parts[1], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
}

export function oauthUrl(state) {
  const c = config();
  if (!c.configured) throw new Error('Facebook OAuth is not configured.');
  const url = new URL(`https://www.facebook.com/${VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', c.appId);
  url.searchParams.set('redirect_uri', c.redirectUri);
  url.searchParams.set('response_type', 'code');
  if (c.loginConfigId) {
    url.searchParams.set('config_id', c.loginConfigId);
    url.searchParams.set('override_default_response_type', 'true');
  } else {
    url.searchParams.set('scope', FACEBOOK_SCOPES.join(','));
  }
  url.searchParams.set('state', state);
  return url.toString();
}

export async function graph(path, token, { method = 'GET', params = {}, fields = null } = {}) {
  if (!token) throw new Error('Facebook account must be connected first.');
  const url = new URL(`${BASE}/${path.replace(/^\//, '')}`);
  if (fields) url.searchParams.set('fields', fields);
  if (method === 'GET') {
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    }
  }
  const proof = createHmac('sha256', config().appSecret).update(token).digest('hex');
  url.searchParams.set('appsecret_proof', proof);
  const options = {
    method,
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(18000)
  };
  if (method !== 'GET' && method !== 'DELETE') {
    options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    options.body = new URLSearchParams(Object.entries(params).map(([name, value]) =>
      [name, typeof value === 'object' ? JSON.stringify(value) : String(value)]));
  }
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    // Do not echo Meta's error message verbatim; it can contain access tokens or other sensitive data.
    const code = Number(data?.error?.code) || response.status;
    const safe = code === 190 ? 'Facebook authorization expired; reconnect your account.' :
      code === 200 || code === 10 ? 'Facebook permissions are insufficient for this operation.' :
      code === 4 || code === 17 || code === 32 || code === 80001 ? 'Meta rate limit reached; retry later.' :
      `Facebook API request failed (code ${code}).`;
    const error = new Error(safe);
    error.status = response.status >= 500 ? 502 : 400;
    error.metaCode = code;
    throw error;
  }
  return data;
}

async function tokenExchange(params) {
  const url = new URL(`${BASE}/oauth/access_token`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error('Meta could not authorize this account. Check the OAuth app configuration.');
  return data;
}

export async function exchangeCode(code) {
  const c = config();
  const short = await tokenExchange({ client_id: c.appId, client_secret: c.appSecret, redirect_uri: c.redirectUri, code });
  try {
    return await tokenExchange({ grant_type: 'fb_exchange_token', client_id: c.appId, client_secret: c.appSecret, fb_exchange_token: short.access_token });
  } catch {
    return short; // A short-lived token is usable, but will require reconnecting earlier.
  }
}

export async function fetchPages(userAccessToken) {
  const pages = [];
  let after = '';
  const seen = new Set();
  do {
    const result = await graph('me/accounts', userAccessToken, {
      params: { limit: 100, ...(after ? { after } : {}) },
      fields: 'id,name,access_token,tasks,picture{url}'
    });
    for (const p of result.data || []) {
      if (!p.id || !p.access_token) continue;
      pages.push({ id: p.id, name: p.name || 'Facebook Page', token: encryptToken(p.access_token),
        tasks: Array.isArray(p.tasks) ? p.tasks : [], picture: p.picture?.data?.url || '' });
    }
    const next = result.paging?.cursors?.after || '';
    if (next && seen.has(next)) break;
    if (next) seen.add(next);
    after = next;
  } while (after && pages.length < 500 && seen.size < 20);
  return pages;
}

export async function readAccount(uid) {
  const snap = await accountRef(uid).get();
  return snap.exists() ? snap.val() : null;
}

export function publicAccount(account) {
  return {
    connected: Boolean(account),
    pages: (account?.pages || []).map(({ id, name, tasks, picture }) => ({ id, name, tasks, picture })),
    selectedPageId: account?.selectedPageId || '',
    autoReply: Boolean(account?.autoReply),
    webhookSubscribed: Boolean(account?.webhookSubscribed),
    persona: account?.persona ? { name: account.persona.name, company: account.persona.company } : null
  };
}

export function selectedPage(account) {
  const page = account?.pages?.find((p) => p.id === account.selectedPageId);
  if (!page) throw new Error('Select a connected Facebook Page first.');
  return { ...page, accessToken: decryptToken(page.token) };
}

export async function subscribePage(page) {
  return graph(`${encodeURIComponent(page.id)}/subscribed_apps`, page.accessToken, {
    method: 'POST', params: { subscribed_fields: 'messages,messaging_postbacks' }
  });
}

export function cleanPersona(value) {
  const trim = (text, max) => (typeof text === 'string' ? text.trim().slice(0, max) : '');
  return {
    name: trim(value?.name, 60) || 'Assistant',
    company: trim(value?.company, 100) || 'the business',
    language: trim(value?.language, 100) || 'English',
    website: trim(value?.website, 250),
    knowledge: trim(value?.websiteKnowledge, 4500),
    firstMessage: trim(value?.firstMessage, 500)
  };
}

export function validatePostId(pageId, postId) {
  // A Page post ID has the form {page-id}_{post-id}; never allow an agent to edit another Page.
  return /^\d+_\d+$/.test(postId || '') && postId.startsWith(`${pageId}_`);
}

export async function listPosts(page, limit = 10) {
  const n = Math.min(Math.max(Number(limit) || 10, 1), 25);
  const result = await graph(`${page.id}/posts`, page.accessToken, {
    fields: 'id,message,created_time,permalink_url,from{id,name}', params: { limit: n }
  });
  return (result.data || []).map(({ id, message, created_time, permalink_url, from }) => ({
    id, message: message || '', created_time, permalink_url: permalink_url || '', from: from?.id || ''
  }));
}

export async function publishPost(page, message) {
  const text = String(message || '').trim();
  if (!text || text.length > 10000) throw new Error('Post text must contain 1–10,000 characters.');
  return graph(`${page.id}/feed`, page.accessToken, { method: 'POST', params: { message: text } });
}

export async function schedulePost(page, message, publishAt) {
  const text = String(message || '').trim();
  if (!text || text.length > 10000) throw new Error('Post text must contain 1–10,000 characters.');
  const date = new Date(publishAt);
  if (Number.isNaN(date.getTime())) throw new Error('Choose a valid publish date and time.');
  const delta = date.getTime() - Date.now();
  if (delta < 10 * 60 * 1000 || delta > 75 * 24 * 60 * 60 * 1000) {
    throw new Error('Meta scheduled posts must be 10 minutes to 75 days in the future.');
  }
  return graph(`${page.id}/feed`, page.accessToken, {
    method: 'POST', params: { message: text, published: false, scheduled_publish_time: Math.floor(date.getTime() / 1000) }
  });
}

export async function listScheduledPosts(page) {
  const result = await graph(`${page.id}/scheduled_posts`, page.accessToken, {
    fields: 'id,message,scheduled_publish_time,is_published', params: { limit: 30 }
  });
  return (result.data || []).map(p => ({ id: p.id, message: p.message || '',
    scheduled_publish_time: p.scheduled_publish_time, is_published: p.is_published }));
}

export async function editPost(page, postId, message) {
  if (!validatePostId(page.id, postId)) throw new Error('Only posts belonging to the selected Page can be edited.');
  const text = String(message || '').trim();
  if (!text || text.length > 10000) throw new Error('Post text must contain 1–10,000 characters.');
  return graph(postId, page.accessToken, { method: 'POST', params: { message: text } });
}

export async function deletePost(page, postId) {
  if (!validatePostId(page.id, postId)) throw new Error('Only posts belonging to the selected Page can be deleted.');
  // Meta restricts post deletion for some developers/apps even with pages_manage_posts.
  return graph(postId, page.accessToken, { method: 'DELETE' });
}

export async function sendMessenger(page, recipientId, text) {
  if (!/^\d+$/.test(String(recipientId))) throw new Error('Invalid Messenger Page-scoped sender ID.');
  const message = String(text || '').trim();
  if (!message || message.length > 2000) throw new Error('Messenger reply must contain 1–2,000 characters.');
  return graph(`${page.id}/messages`, page.accessToken, {
    method: 'POST', params: { messaging_type: 'RESPONSE', recipient: { id: recipientId }, message: { text: message } }
  });
}

export function issueToolToken(uid) {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const payload = `${Buffer.from(uid).toString('base64url')}.${expiry}`;
  const signature = createHmac('sha256', keyBytes()).update(`facebook-tool:${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}
export function verifyToolToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !/^\d+$/.test(parts[1])) return '';
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', keyBytes()).update(`facebook-tool:${payload}`).digest('base64url');
  if (Buffer.byteLength(parts[2]) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected)) ||
      Number(parts[1]) < Date.now() / 1000) return '';
  const uid = Buffer.from(parts[0], 'base64url').toString('utf8');
  return /^[\w-]{1,128}$/.test(uid) ? uid : '';
}

export function verifySignature(body, signature) {
  if (!/^sha256=[a-f0-9]{64}$/i.test(signature || '')) return false;
  const expected = `sha256=${createHmac('sha256', config().appSecret).update(body).digest('hex')}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
