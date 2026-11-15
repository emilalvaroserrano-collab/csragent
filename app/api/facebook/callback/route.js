import { NextResponse } from 'next/server';
import { accountRef, config, encryptToken, exchangeCode, fetchPages, oauthStateRef, pageOwnerRef, readAccount, sha256 } from '@/lib/facebook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function back(result) {
  const base = new URL(config().redirectUri || 'http://localhost:3000/api/facebook/callback');
  return NextResponse.redirect(new URL(`/?facebook=${encodeURIComponent(result)}`, base.origin));
}
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const state = params.get('state') || '';
  const code = params.get('code') || '';
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(state)) return back('invalid_state');
  try {
    const ref = oauthStateRef(sha256(state));
    let authorized = null;
    const consumed = await ref.transaction(current => {
      authorized = null;
      if (!current || !current.uid || Date.now() - current.createdAt > 10 * 60 * 1000) return;
      authorized = current.uid;
      return null; // consume OAuth state atomically; no replay
    }, undefined, false);
    if (!consumed.committed || !authorized) return back('expired_state');
    if (!code || params.has('error')) return back('cancelled');
    const tokens = await exchangeCode(code);
    const pages = await fetchPages(tokens.access_token);
    const existing = await readAccount(authorized);
    const selectedPageId = pages.some(p => p.id === existing?.selectedPageId) ? existing.selectedPageId : '';
    if (existing?.selectedPageId && !selectedPageId) {
      await pageOwnerRef(existing.selectedPageId).transaction(owner => owner === authorized ? null : undefined);
    }
    await accountRef(authorized).set({
      userToken: encryptToken(tokens.access_token),
      tokenExpiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
      pages,
      selectedPageId,
      autoReply: Boolean(selectedPageId && existing?.autoReply),
      webhookSubscribed: Boolean(selectedPageId && existing?.webhookSubscribed),
      persona: existing?.persona || null,
      connectedAt: Date.now()
    });
    return back(pages.length ? 'connected' : 'no_pages');
  } catch {
    return back('error');
  }
}
