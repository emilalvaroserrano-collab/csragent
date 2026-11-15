import { NextResponse } from 'next/server';
import { readAccount } from '@/lib/facebook';
import { sendReply } from '@/lib/facebook-messenger';
import { verifyFirebaseToken } from '@/lib/verify-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const { recipientId, message } = await request.json();
    const account = await readAccount(auth.uid);
    const result = await sendReply(auth.uid, account, recipientId, message);
    return NextResponse.json({ ok: true, messageId: result.message_id });
  } catch (err) {
    return NextResponse.json({ error: err.message || 'Messenger reply failed.' }, { status: err.status || 400 });
  }
}
