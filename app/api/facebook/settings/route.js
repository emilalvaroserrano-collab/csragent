import { NextResponse } from 'next/server';
import { accountRef, cleanPersona, readAccount } from '@/lib/facebook';
import { verifyFirebaseToken } from '@/lib/verify-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const body = await request.json();
    const account = await readAccount(auth.uid);
    if (!account?.selectedPageId) return NextResponse.json({ error: 'Select a Facebook Page first.' }, { status: 400 });
    const data = {};
    if (typeof body.autoReply === 'boolean') {
      if (body.autoReply && (!process.env.GEMINI_API_KEY || !account.webhookSubscribed)) {
        return NextResponse.json({ error: 'Enable Messenger webhook and configure GEMINI_API_KEY before auto-reply.' }, { status: 400 });
      }
      data.autoReply = body.autoReply;
    }
    if (body.persona && typeof body.persona === 'object') data.persona = cleanPersona(body.persona);
    if (!Object.keys(data).length) return NextResponse.json({ error: 'No settings provided.' }, { status: 400 });
    await accountRef(auth.uid).update(data);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err?.message || 'Could not save settings.' }, { status: 400 });
  }
}
