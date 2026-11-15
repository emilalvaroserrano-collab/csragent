import { NextResponse } from 'next/server';
import { config, publicAccount, readAccount } from '@/lib/facebook';
import { verifyFirebaseToken } from '@/lib/verify-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!config().configured) return NextResponse.json({ configured: false, connected: false, pages: [] });
  try {
    const account = await readAccount(auth.uid);
    return NextResponse.json({ configured: true, ...publicAccount(account) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Unable to load Facebook Pages connection.' }, { status: 503 });
  }
}
