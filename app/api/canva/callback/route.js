import { NextResponse } from 'next/server';
import { accountFromTokens, accountRef, config, decrypt, exchangeCode, getProfileWithToken, stateRef } from '@/lib/canva';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function redirect(result) {
  const { redirectUri } = config();
  const origin = redirectUri ? new URL(redirectUri).origin : 'http://localhost:3000';
  return NextResponse.redirect(new URL(`/?canva=${encodeURIComponent(result)}`, origin));
}
export async function GET(request) {
  const query = new URL(request.url).searchParams;
  const state = query.get('state') || '';
  if (!/^[a-zA-Z0-9_-]{40,100}$/.test(state)) return redirect('invalid_state');
  try {
    const ref = stateRef(state);
    let saved = null;
    const tx = await ref.transaction(current => {
      if (!current || !current.uid || !current.verifier ||
        !Number.isFinite(current.createdAt) || Date.now() - current.createdAt > 600_000 ||
        current.createdAt > Date.now() + 15_000) return;
      saved = { uid: current.uid, verifier: current.verifier };
      return null;
    }, undefined, false);
    if (!tx.committed || !saved) return redirect('expired_state');
    if (query.has('error') || !query.get('code')) return redirect('cancelled');
    const tokens = await exchangeCode(query.get('code'), decrypt(saved.verifier));
    const profile = await getProfileWithToken(tokens.access_token);
    await accountRef(saved.uid).set(accountFromTokens(tokens, profile));
    return redirect('connected');
  } catch {
    return redirect('error');
  }
}
