import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { config, verifySignature } from '@/lib/facebook';
import { queueEvent, drainJobs } from '@/lib/facebook-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  if (params.get('hub.mode') !== 'subscribe' ||
    !config().webhookVerifyToken || params.get('hub.verify_token') !== config().webhookVerifyToken) {
    return new Response('Forbidden', { status: 403 });
  }
  return new Response(params.get('hub.challenge') || '', { status: 200, headers: { 'Content-Type': 'text/plain' } });
}
export async function POST(request) {
  if (Number(request.headers.get('content-length') || 0) > 1024 * 1024) return new Response('Payload too large', { status: 413 });
  const body = await request.text();
  if (body.length > 1024 * 1024) return new Response('Payload too large', { status: 413 });
  if (!config().appSecret || !verifySignature(body, request.headers.get('x-hub-signature-256'))) {
    return NextResponse.json({ error: 'Invalid webhook signature.' }, { status: 403 });
  }
  let payload;
  try { payload = JSON.parse(body); } catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 }); }
  if (payload.object !== 'page') return NextResponse.json({ ok: true });
  const events = (payload.entry || []).flatMap(entry =>
    (entry.messaging || []).filter(message => message.message?.text && !message.message?.is_echo)
      .map(message => ({ pageId: String(entry.id), event: message }))
  ).slice(0, 100);
  // Commit to the queue before ACK: if Firebase is down, Meta retries the webhook delivery.
  try {
    for (const { pageId, event } of events) await queueEvent(pageId, event);
  } catch {
    return NextResponse.json({ error: 'Could not store webhook for processing.' }, { status: 503 });
  }
  // Use after() for low-latency processing without delaying Meta's acknowledgment.
  // A separately scheduled /api/facebook/jobs invocation can retry interrupted work.
  if (events.length) after(() => drainJobs(40).catch(err => console.error('Facebook webhook worker error:', err?.message)));
  return NextResponse.json({ ok: true });
}
