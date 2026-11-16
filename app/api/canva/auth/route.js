import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { authorizeUrl, config, createPkce, encrypt, stateRef } from '@/lib/canva';
import { verifyFirebaseToken } from '@/lib/verify-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    if (!config().configured) return NextResponse.json({ error: 'Canva OAuth is not configured on this server.' }, { status: 503 });
    const state = randomBytes(32).toString('base64url');
    const { verifier, challenge } = createPkce();
    await stateRef(state).set({ uid: auth.uid, verifier: encrypt(verifier), createdAt: Date.now() });
    return NextResponse.json({ url: authorizeUrl({ state, challenge }) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Unable to begin Canva login.' }, { status: 503 });
  }
}
