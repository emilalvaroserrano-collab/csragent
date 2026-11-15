import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import * as crypto from 'node:crypto';

// Run with: node --experimental-vm-modules --test tests/facebook.test.mjs
// Isolates the Facebook server module without needing Next.js or live Meta credentials.
process.env.FACEBOOK_APP_ID = '123';
process.env.FACEBOOK_APP_SECRET = 'test-secret';
process.env.FACEBOOK_REDIRECT_URI = 'https://example.com/api/facebook/callback';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
const context = createContext({ Buffer, process, URL, URLSearchParams, AbortSignal, console, fetch: undefined });
const code = await readFile(resolve('lib/facebook.js'), 'utf8');
const module = new SourceTextModule(code, { context });
await module.link(async specifier => {
  if (specifier === 'node:crypto') {
    return new SyntheticModule(Object.keys(crypto), function() {
      for (const name of Object.keys(crypto)) this.setExport(name, crypto[name]);
    }, { context });
  }
  if (specifier === '@/lib/firebase-admin') {
    return new SyntheticModule(['getAdminDb'], function() { this.setExport('getAdminDb', () => null); }, { context });
  }
  if (specifier === 'server-only') return new SyntheticModule([], () => {}, { context });
  throw Error(`Unexpected import ${specifier}`);
});
await module.evaluate();
const fb = module.namespace;

test('AES-256-GCM encrypts credentials and rejects modified ciphertext', () => {
  const encrypted = fb.encryptToken('secret-page-access-token');
  assert.ok(encrypted.startsWith('v1.'));
  assert.ok(!encrypted.includes('secret-page-access-token'));
  assert.equal(fb.decryptToken(encrypted), 'secret-page-access-token');
  const pieces = encrypted.split('.');
  pieces[3] = pieces[3].slice(0, -1) + (pieces[3].endsWith('A') ? 'B' : 'A');
  assert.throws(() => fb.decryptToken(pieces.join('.')));
});

test('tool grants are signed and expire', () => {
  const signed = fb.issueToolToken('firebase-user-1');
  assert.equal(fb.verifyToolToken(signed), 'firebase-user-1');
  assert.equal(fb.verifyToolToken(signed + 'h'), '');
  const parts = signed.split('.');
  parts[1] = '1';
  assert.equal(fb.verifyToolToken(parts.join('.')), '');
});

test('webhook signature requires a valid raw-body HMAC', () => {
  const body = '{"object":"page","entry":[]}';
  const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(body).digest('hex');
  assert.equal(fb.verifySignature(body, signature), true);
  assert.equal(fb.verifySignature(body + ' ', signature), false);
  assert.equal(fb.verifySignature(body, 'sha256=bad'), false);
});

test('public Facebook status contains no user/Page access tokens', () => {
  const status = fb.publicAccount({
    userToken: 'encrypted-user-token', selectedPageId: '12', autoReply: true,
    pages: [{ id: '12', name: 'Demo Page', token: 'encrypted-page-token', tasks: ['CREATE_CONTENT'] }]
  });
  assert.equal(status.pages[0].name, 'Demo Page');
  assert.ok(!JSON.stringify(status).includes('encrypted'));
  assert.equal(status.autoReply, true);
});

test('post mutation requires selected-Page ownership and Graph API POST form encoding', async () => {
  const page = { id: '1234', accessToken: 'page-test-token' };
  assert.equal(fb.validatePostId('1234', '1234_8888'), true);
  assert.equal(fb.validatePostId('1234', '9999_8888'), false);
  await assert.rejects(() => fb.editPost(page, '9999_8888', 'Hacked'), /selected Page/);
  const calls = [];
  context.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, json: async () => ({ id: '1234_8888' }) };
  };
  const result = await fb.publishPost(page, 'Hello Meta API');
  assert.equal(result.id, '1234_8888');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/v27.0/1234/feed');
  assert.equal(new URLSearchParams(calls[0].options.body).get('message'), 'Hello Meta API');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer page-test-token');
  assert.ok(new URL(calls[0].url).searchParams.has('appsecret_proof'));
});

test('OAuth supports Facebook Login for Business config_id and classic scope flow', () => {
  const classic = new URL(fb.oauthUrl('test-state'));
  assert.ok(classic.searchParams.get('scope').includes('pages_messaging'));
  assert.equal(classic.searchParams.has('config_id'), false);
  process.env.FACEBOOK_LOGIN_CONFIG_ID = '987654321';
  const business = new URL(fb.oauthUrl('test-state'));
  assert.equal(business.searchParams.get('config_id'), '987654321');
  assert.equal(business.searchParams.get('scope'), null);
  assert.equal(business.searchParams.get('override_default_response_type'), 'true');
  delete process.env.FACEBOOK_LOGIN_CONFIG_ID;
});

test('native Meta scheduling validates 10 minutes to 75 days window', async () => {
  const page = { id: '1234', accessToken: 'page-test-token' };
  await assert.rejects(() => fb.schedulePost(page, 'Draft', new Date(Date.now() + 60_000).toISOString()), /10 minutes/);
  await assert.rejects(() => fb.schedulePost(page, 'Draft', new Date(Date.now() + 76 * 86400_000).toISOString()), /75 days/);
  const captured = [];
  context.fetch = async (_url, options) => {
    captured.push(options);
    return { ok: true, json: async () => ({ id: '1234_42' }) };
  };
  await fb.schedulePost(page, 'Scheduled draft', new Date(Date.now() + 3600_000).toISOString());
  const form = new URLSearchParams(captured[0].body);
  assert.equal(form.get('published'), 'false');
  assert.equal(form.get('message'), 'Scheduled draft');
  assert.ok(Number(form.get('scheduled_publish_time')) > Date.now() / 1000);
});
