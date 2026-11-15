import { NextResponse } from 'next/server';
import { drainJobs } from '@/lib/facebook-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  try {
    const processed = await drainJobs(60);
    return NextResponse.json({ ok: true, processed });
  } catch {
    return NextResponse.json({ error: 'Facebook jobs worker failed.' }, { status: 503 });
  }
}
