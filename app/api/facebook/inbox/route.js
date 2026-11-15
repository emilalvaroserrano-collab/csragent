import { NextResponse } from 'next/server';
import { readAccount } from '@/lib/facebook';
import { listRecentConversations } from '@/lib/facebook-messenger';
import { verifyFirebaseToken } from '@/lib/verify-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const account = await readAccount(auth.uid);
    if (!account?.selectedPageId) return NextResponse.json({ conversations: [] });
    const conversations = await listRecentConversations(auth.uid, account.selectedPageId);
    return NextResponse.json({ conversations }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: err.message || 'Unable to load Messenger inbox.' }, { status: 503 });
  }
}
