import { NextResponse } from 'next/server';
import { deletePost, editPost, listPosts, listScheduledPosts, publishPost, schedulePost, readAccount, selectedPage, verifyToolToken } from '@/lib/facebook';
import { listRecentConversations, readConversation, sendReply } from '@/lib/facebook-messenger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorResult(message) { return NextResponse.json({ results: [{ result: message }], result: message }); }
export async function POST(request) {
  const token = new URL(request.url).searchParams.get('token') || '';
  const uid = verifyToolToken(token);
  if (!uid) return NextResponse.json({ error: 'Unauthorized agent tool call.' }, { status: 401 });
  try {
    const account = await readAccount(uid);
    const page = selectedPage(account);
    const body = await request.json();
    const toolCall = body?.message?.toolCalls?.[0] || body?.toolCall || body;
    const name = toolCall?.function?.name || toolCall?.name || body?.name;
    const args = typeof toolCall?.function?.arguments === 'string'
      ? JSON.parse(toolCall.function.arguments)
      : toolCall?.function?.arguments || toolCall?.arguments || body?.arguments || {};
    let result;
    switch (name) {
      case 'facebook_list_posts':
        result = JSON.stringify(await listPosts(page, args.limit)); break;
      case 'facebook_list_scheduled_posts':
        result = JSON.stringify(await listScheduledPosts(page)); break;
      case 'facebook_schedule_post':
        if (args.confirm !== true) throw new Error('Ask for explicit owner confirmation before scheduling.');
        result = JSON.stringify(await schedulePost(page, args.message, args.publishAt)); break;
      case 'facebook_publish_post':
        if (args.confirm !== true) throw new Error('Ask for explicit owner confirmation before publishing.');
        result = JSON.stringify(await publishPost(page, args.message)); break;
      case 'facebook_edit_post':
        if (args.confirm !== true) throw new Error('Ask for explicit owner confirmation before editing.');
        result = JSON.stringify(await editPost(page, args.postId, args.message)); break;
      case 'facebook_delete_post':
        if (args.confirm !== true) throw new Error('Ask for explicit owner confirmation before deleting.');
        result = JSON.stringify(await deletePost(page, args.postId)); break;
      case 'facebook_list_conversations':
        result = JSON.stringify(await listRecentConversations(uid, page.id)); break;
      case 'facebook_read_conversation': {
        const conv = await readConversation(uid, page.id, String(args.senderId || ''));
        result = JSON.stringify(conv?.recent || []); break;
      }
      case 'facebook_reply_messenger':
        if (args.confirm !== true) throw new Error('Ask for explicit owner confirmation before sending a Messenger reply.');
        result = JSON.stringify(await sendReply(uid, account, String(args.senderId || ''), args.message)); break;
      default: throw new Error(`Unknown Facebook tool: ${name}`);
    }
    return NextResponse.json({ results: [{ toolCallId: toolCall?.id, result }], result });
  } catch (err) {
    return errorResult(`Facebook tool failed: ${err?.message || 'Unknown error'}`);
  }
}
