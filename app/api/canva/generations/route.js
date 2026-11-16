import { NextResponse } from 'next/server';
import { generateDesign, getGeneration } from '@/lib/canva-operations';
import { verifyFirebaseToken } from '@/lib/verify-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handler(request, method) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const data = method === 'POST' ? await generateDesign(auth.uid, await request.json())
      : await getGeneration(auth.uid, new URL(request.url).searchParams.get('id'));
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return NextResponse.json({ error: error?.message || 'Canva generation failed.' }, { status: error?.status || 400 }); }
}
export const GET = request => handler(request, 'GET');
export const POST = request => handler(request, 'POST');
