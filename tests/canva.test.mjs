import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import * as crypto from 'node:crypto';

process.env.CANVA_CLIENT_ID = 'test-client';
process.env.CANVA_CLIENT_SECRET = 'test-secret';
process.env.CANVA_REDIRECT_URI = 'https://example.org/api/canva/callback';
process.env.CANVA_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.CANVA_TOOL_SIGNING_SECRET = crypto.randomBytes(32).toString('hex');
process.env.CANVA_ENABLE_PREVIEW_GENERATION = 'false';

const saved = new Map();
function reference(path) {
  return {
    async get() { const value = saved.get(path); return { exists: () => value !== undefined, val: () => value }; },
    async set(value) { saved.set(path, value); },
    async remove() { saved.delete(path); },
    async update(value) { saved.set(path, { ...(saved.get(path) || {}), ...value }); },
    async transaction(fn) {
      const next = fn(saved.get(path) || null);
      if (next === undefined) return { committed: false };
      if (next === null) saved.delete(path);
      else saved.set(path, next);
      return { committed: true };
    }
  };
}
const context = createContext({ Buffer, URL, URLSearchParams, process, console, setTimeout, AbortSignal, fetch: undefined });
function synthetic(names, fn) {
  return new SyntheticModule(names, function() { for (const [name, value] of Object.entries(fn())) this.setExport(name, value); }, { context });
}
const c = new SourceTextModule(readFileSync('lib/canva.js', 'utf8'), { context });
const ops = new SourceTextModule(readFileSync('lib/canva-operations.js', 'utf8'), { context });
const crypt = synthetic(Object.keys(crypto), () => crypto);
const admin = synthetic(['getAdminDb'], () => ({ getAdminDb: () => ({ ref: reference }) }));
const server = synthetic([], () => ({}));
const link = async name => {
  if (name === 'server-only') return server;
  if (name === 'node:crypto') return crypt;
  if (name === '@/lib/firebase-admin') return admin;
  if (name === '@/lib/canva') return c;
  throw Error(`unexpected import ${name}`);
};
await c.link(link); await c.evaluate();
await ops.link(link); await ops.evaluate();
const canva = c.namespace, design = ops.namespace;

test('Canva OAuth uses PKCE S256, valid consent scopes, redirect and random state', () => {
  const pkce = canva.createPkce();
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(pkce.challenge, crypto.createHash('sha256').update(pkce.verifier).digest('base64url'));
  const url = new URL(canva.authorizeUrl({ state: 'independent-state', challenge: pkce.challenge }));
  assert.equal(url.origin, 'https://www.canva.com');
  assert.equal(url.pathname, '/api/oauth/authorize');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), process.env.CANVA_REDIRECT_URI);
  assert.ok(url.searchParams.get('scope').includes('design:content:write'));
  assert.ok(url.searchParams.get('scope').includes('design:content:read'));
  assert.ok(!url.href.includes('test-secret'));
});

test('Canva encrypted tokens round-trip; tampered ciphertext is rejected', () => {
  const encrypted = canva.encrypt('highly-private-canva-refresh-token');
  assert.ok(!encrypted.includes('highly-private'));
  assert.equal(canva.decrypt(encrypted), 'highly-private-canva-refresh-token');
  const pieces = encrypted.split('.'); pieces[2] = crypto.randomBytes(16).toString('base64url');
  assert.throws(() => canva.decrypt(pieces.join('.')));
});

test('Canva public account status never leaks access/refresh tokens', () => {
  const acc = canva.accountFromTokens({ access_token: 'accessSecret', refresh_token: 'refreshSecret', expires_in: 3600 }, { display_name: 'Owner A' });
  const status = canva.publicAccount(acc);
  assert.equal(status.connected, true);
  assert.equal(status.name, 'Owner A');
  assert.ok(!JSON.stringify(status).includes('Secret'));
  assert.ok(!Object.keys(status).some(x => /token/i.test(x)));
});

test('Canva tool token is signed, user-scoped, and expires', () => {
  const now = Date.now();
  const token = canva.issueToolToken('owner-1', now);
  assert.equal(canva.verifyToolToken(token, now), 'owner-1');
  assert.equal(canva.verifyToolToken(token + 'x', now), '');
  assert.equal(canva.verifyToolToken(token, now + 91 * 60_000), '');
  assert.equal(canva.verifyToolToken('abc.def', now), '');
});

test('Canva token exchange uses Basic auth, code verifier, and never exposes secret to browser', async () => {
  const captures = [];
  context.fetch = async (url, opts) => {
    captures.push({ url: String(url), opts });
    return { ok: true, json: async () => ({ access_token: 'firstAccess', refresh_token: 'firstRefresh', expires_in: 14400 }) };
  };
  const token = await canva.exchangeCode('authorization-code', 'our-secret-pkce-verifier');
  assert.equal(token.access_token, 'firstAccess');
  assert.equal(captures[0].url, 'https://api.canva.com/rest/v1/oauth/token');
  assert.equal(captures[0].opts.headers.Authorization, `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`);
  const params = new URLSearchParams(captures[0].opts.body);
  assert.equal(params.get('grant_type'), 'authorization_code');
  assert.equal(params.get('code_verifier'), 'our-secret-pkce-verifier');
  assert.equal(params.get('redirect_uri'), process.env.CANVA_REDIRECT_URI);
});

test('Rotating refresh credentials are saved per owner; old refresh token cannot overwrite newer state', async () => {
  const owner = 'canva-owner-b';
  const ref = canva.accountRef(owner);
  const original = canva.accountFromTokens({ access_token: 'access-expired', refresh_token: 'refresh-original', expires_in: 0 });
  original.expiresAt = Date.now() - 1000;
  await ref.set(original);
  let refreshCalls = 0;
  context.fetch = async (_url, opts) => {
    refreshCalls++;
    assert.equal(new URLSearchParams(opts.body).get('refresh_token'), 'refresh-original');
    return { ok: true, json: async () => ({ access_token: 'access-rotated', refresh_token: 'refresh-rotated', expires_in: 14400 }) };
  };
  assert.equal(await canva.accessToken(owner), 'access-rotated');
  const updated = (await ref.get()).val();
  assert.equal(canva.decrypt(updated.refreshToken), 'refresh-rotated');
  assert.equal(await canva.accessToken(owner), 'access-rotated');
  assert.equal(refreshCalls, 1);
});

test('Canva create design validates dimensions, asset IDs, and preset body', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(design.designBody({ title: 'Campaign', type: 'custom', width: 1080, height: 1350 }))), {
    type: 'type_and_asset', title: 'Campaign', design_type: { type: 'custom', width: 1080, height: 1350 }
  });
  assert.throws(() => design.designBody({ title: 'Huge', width: 8000, height: 8000 }), /25 million/);
  assert.throws(() => design.designBody({ title: 'Bad', type: 'presentation', assetId: '../../other-user' }), /asset ID/);
  assert.deepEqual(JSON.parse(JSON.stringify(design.designBody({ title: 'Slides', type: 'presentation' }).design_type)), { type: 'preset', name: 'presentation' });
  assert.throws(() => design.safeId('../example'), /Invalid/);
});

test('Canva URL asset uploads reject local/private targets and unsafe URL schemes', () => {
  for (const url of ['http://localhost/test.png', 'https://127.0.0.1/test', 'https://[::1]/test.png',
    'https://internal.local/img', 'https://evil.com:444/test.png', 'file:///etc/passwd']) {
    assert.throws(() => design.publicAssetUrl(url), /public HTTPS/);
  }
  assert.equal(design.publicAssetUrl('https://cdn.example.org/image.png'), 'https://cdn.example.org/image.png');
});

test('Canva design listing and export use fixed API paths and preserve editing URLs', async () => {
  const owner = 'canva-owner-c';
  await canva.accountRef(owner).set(canva.accountFromTokens({ access_token: 'canvaOwnerToken', refresh_token: 'ownerRefreshToken', expires_in: 3600 }));
  const urls = [];
  context.fetch = async (url, opts) => {
    urls.push({ url: String(url), opts });
    if (String(url).endsWith('/exports')) return { ok: true, json: async () => ({ job: { id: 'job-123', status: 'in_progress' } }) };
    return { ok: true, json: async () => ({ items: [{ id: 'D123', title: 'Owner Design', urls: { edit_url: 'https://www.canva.com/design/D123/edit' } }] }) };
  };
  const result = await design.listDesigns(owner, { query: 'Owner' });
  assert.equal(result.items[0].editUrl, 'https://www.canva.com/design/D123/edit');
  assert.equal(new URL(urls[0].url).searchParams.get('query'), 'Owner');
  await design.startExport(owner, { designId: 'D123', format: 'png' });
  assert.equal(new URL(urls[1].url).pathname, '/rest/v1/exports');
  assert.deepEqual(JSON.parse(urls[1].opts.body), { design_id: 'D123', format: { type: 'png' } });
  assert.equal(urls[1].opts.headers.Authorization, 'Bearer canvaOwnerToken');
});

test('Canva preview generation is disabled by default', async () => {
  await assert.rejects(() => design.generateDesign('owner', { brief: 'Make presentation' }), /disabled/);
});


test('Canva JPG and MP4 export requests include mandatory quality fields', async () => {
  const owner = 'canva-owner-d';
  await canva.accountRef(owner).set(canva.accountFromTokens({ access_token: 'owner-token', refresh_token: 'owner-refresh', expires_in: 3600 }));
  const bodies = [];
  context.fetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ job: { id: 'job-4', status: 'in_progress' } }) };
  };
  await design.startExport(owner, { designId: 'D123', format: 'jpg' });
  await design.startExport(owner, { designId: 'D123', format: 'mp4' });
  assert.deepEqual(JSON.parse(JSON.stringify(bodies[0].format)), { type: 'jpg', quality: 85 });
  assert.deepEqual(JSON.parse(JSON.stringify(bodies[1].format)), { type: 'mp4', quality: 'horizontal_720p' });
});

test('Canva preview comments cannot be used by default in public apps', async () => {
  assert.equal(canva.config().previewComments, false);
  await assert.rejects(() => design.commentOnDesign('owner', { designId: 'D123', message: 'Great work' }), /preview-only/);
});
