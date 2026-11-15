import { NextResponse } from 'next/server';
import { accountRef, database, pageOwnerRef, readAccount, selectedPage, graph } from '@/lib/facebook';
import { verifyFirebaseToken } from '@/lib/verify-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const account = await readAccount(auth.uid);
    if (account?.selectedPageId) {
      const page = selectedPage(account);
      // Best effort: Meta might revoke permissions before disconnection.
      await graph(`${page.id}/subscribed_apps`, page.accessToken, { method: 'DELETE' }).catch(() => {});
      await pageOwnerRef(page.id).transaction(current => current === auth.uid ? null : undefined);
      await database().ref(`serverIntegrations/facebook/deliveries/${page.id}`).remove();
      await database().ref(`serverIntegrations/facebook/webhookJobs/${page.id}`).remove();
    }
    await database().ref(`serverIntegrations/facebook/conversations/${auth.uid}`).remove();
    await accountRef(auth.uid).remove();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Facebook disconnection failed.' }, { status: 503 });
  }
}
