import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { config, oauthStateRef, oauthUrl, sha256 } from '@/lib/facebook';
import { verifyFirebaseToken } from '@/lib/verify-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!config().configured) return NextResponse.json({ error: 'Meta OAuth not configured on server.' }, { status: 503 });
  try {
    const state = randomBytes(32).toString('base64url');
    await oauthStateRef(sha256(state)).set({ uid: auth.uid, createdAt: Date.now() });
    return NextResponse.json({ url: oauthUrl(state) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Could not start Facebook login.' }, { status: 503 });
  }
}
