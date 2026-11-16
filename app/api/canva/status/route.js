import { NextResponse } from 'next/server';
import { config, publicAccount, readAccount } from '@/lib/canva';
import { verifyFirebaseToken } from '@/lib/verify-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const c = config();
    const account = c.configured ? await readAccount(auth.uid) : null;
    return NextResponse.json({ configured: c.configured, previewGeneration: c.previewGeneration,
      ...publicAccount(account) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Could not load Canva connection.' }, { status: 503 });
  }
}
