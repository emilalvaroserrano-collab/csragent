import { NextResponse } from 'next/server';

import { buildOverrides } from '@/lib/agent-overrides';
import { issueToolToken, readAccount } from '@/lib/facebook';
import { verifyFirebaseToken } from '@/lib/verify-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return NextResponse.json(
      { error: 'Invalid request.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // Check Gmail connection status for this user.
  let gmailConnected = false;
  let gmailEmail = '';
  try {
    const { getAdminDb } = await import('@/lib/firebase-admin');
    const db = getAdminDb();
    if (db) {
      const snap = await db.ref(`users/${auth.uid}/gmail`).get();
      if (snap.exists()) {
        gmailConnected = true;
        gmailEmail = snap.val()?.email || '';
      }
    }
  } catch (error) {}

  let facebookConnected = false;
  let facebookPageName = '';
  let facebookToolToken = '';
  try {
    const account = await readAccount(auth.uid);
    const page = account?.pages?.find(p => p.id === account.selectedPageId);
    if (page && account?.webhookSubscribed) {
      facebookConnected = true;
      facebookPageName = page.name;
      facebookToolToken = issueToolToken(auth.uid);
    }
  } catch (error) {}

  body = { ...body, gmailConnected, gmailEmail, uid: auth.uid, facebookConnected, facebookPageName, facebookToolToken };

  try {
    const overrides = buildOverrides(body);
    return NextResponse.json(
      { overrides },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || 'Unable to build the voice configuration.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
