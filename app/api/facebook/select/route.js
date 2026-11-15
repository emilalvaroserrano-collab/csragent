import { NextResponse } from 'next/server';
import { accountRef, pageOwnerRef, readAccount, selectedPage, subscribePage } from '@/lib/facebook';
import { verifyFirebaseToken } from '@/lib/verify-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const { pageId } = await request.json();
    const account = await readAccount(auth.uid);
    if (!account) return NextResponse.json({ error: 'Connect Facebook first.' }, { status: 400 });
    const page = account.pages.find(p => p.id === pageId);
    if (!page) return NextResponse.json({ error: 'This Page is not in your authorized Page list.' }, { status: 403 });
    const ownerRef = pageOwnerRef(pageId);
    const existing = await ownerRef.get();
    if (existing.exists() && existing.val() !== auth.uid) {
      return NextResponse.json({ error: 'This Page is already assigned to another CSR Studio account.' }, { status: 409 });
    }
    // A successful Page subscription is required before we claim Messenger is connected.
    await subscribePage({ ...page, accessToken: selectedPage({ ...account, selectedPageId: pageId }).accessToken });
    const previousPage = account.selectedPageId;
    await ownerRef.transaction(current => (!current || current === auth.uid ? auth.uid : undefined));
    const owner = await ownerRef.get();
    if (owner.val() !== auth.uid) return NextResponse.json({ error: 'This Page was connected by another account.' }, { status: 409 });
    await accountRef(auth.uid).update({ selectedPageId: pageId, autoReply: previousPage === pageId && Boolean(account.autoReply), webhookSubscribed: true });
    if (previousPage && previousPage !== pageId) {
      await pageOwnerRef(previousPage).transaction(current => current === auth.uid ? null : undefined);
    }
    return NextResponse.json({ ok: true, pageId });
  } catch (err) {
    return NextResponse.json({ error: err.message || 'Could not select this Page.' }, { status: err.status || 400 });
  }
}
