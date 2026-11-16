import { NextResponse } from 'next/server';
import { createDesign, getDesign, listDesigns } from '@/lib/canva-operations';
import { verifyFirebaseToken } from '@/lib/verify-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handler(request, method) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const data = method === 'POST'
      ? await createDesign(auth.uid, await request.json())
      : new URL(request.url).searchParams.get('id')
        ? await getDesign(auth.uid, new URL(request.url).searchParams.get('id'))
        : await listDesigns(auth.uid, Object.fromEntries(new URL(request.url).searchParams.entries()));
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error?.message || 'Canva request failed.' }, { status: error?.status || 400 });
  }
}
export const GET = request => handler(request, 'GET');
export const POST = request => handler(request, 'POST');
