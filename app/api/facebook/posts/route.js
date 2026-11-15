import { NextResponse } from 'next/server';
import { deletePost, editPost, listPosts, listScheduledPosts, publishPost, schedulePost, readAccount, selectedPage } from '@/lib/facebook';
import { verifyFirebaseToken } from '@/lib/verify-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handle(request, operation) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const page = selectedPage(await readAccount(auth.uid));
    const payload = operation === 'list' ? {} : await request.json();
    let data;
    if (operation === 'list') data = await listPosts(page);
    if (operation === 'create') data = payload.publishAt
      ? await schedulePost(page, payload.message, payload.publishAt)
      : await publishPost(page, payload.message);
    if (operation === 'scheduled') data = await listScheduledPosts(page);
    if (operation === 'update') data = await editPost(page, payload.postId, payload.message);
    if (operation === 'delete') {
      if (payload.confirm !== true) throw new Error('Confirm deletion before deleting a Page post.');
      data = await deletePost(page, payload.postId);
    }
    return NextResponse.json({ ok: true, data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: err.message || 'Facebook Page operation failed.' }, { status: err.status || 400 });
  }
}
export async function GET(req) { return handle(req, new URL(req.url).searchParams.get('scheduled') === '1' ? 'scheduled' : 'list'); }
export async function POST(req) { return handle(req, 'create'); }
export async function PATCH(req) { return handle(req, 'update'); }
export async function DELETE(req) { return handle(req, 'delete'); }
