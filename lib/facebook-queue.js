import 'server-only';

import { database, webhookJobRef } from '@/lib/facebook';
import { handleMessage } from '@/lib/facebook-messenger';

/** Persist first, then ACK Meta. Queued jobs survive serverless restarts. */
export async function queueEvent(pageId, event) {
  const messageId = String(event.message?.mid || '');
  if (!/^\d+$/.test(pageId) || !messageId || typeof event.message?.text !== 'string') return;
  const ref = webhookJobRef(pageId, messageId);
  await ref.transaction(current => current || {
    pageId, event: {
      sender: { id: String(event.sender?.id || '') },
      message: { mid: messageId, text: event.message.text.slice(0, 2000) },
      timestamp: Number(event.timestamp) || Date.now()
    },
    status: 'queued', attempts: 0, nextAttemptAt: 0, createdAt: Date.now()
  }, undefined, false);
}

export async function runJob(ref, job) {
  const now = Date.now();
  const lock = await ref.transaction(current => {
    if (!current || current.status === 'done' || current.attempts >= 6 ||
      (current.status === 'processing' && current.leaseUntil > now) ||
      (current.nextAttemptAt || 0) > now) return;
    return { ...current, status: 'processing', leaseUntil: now + 90000, attempts: (current.attempts || 0) + 1 };
  }, undefined, false);
  if (!lock.committed) return;
  try {
    await handleMessage(job.pageId, job.event);
    await ref.remove();
  } catch (err) {
    const tries = (job.attempts || 0) + 1;
    if (tries >= 6) {
      await ref.update({ status: 'failed', leaseUntil: 0, failedAt: Date.now() });
    } else {
      await ref.update({ status: 'queued', leaseUntil: 0, nextAttemptAt: Date.now() + Math.min(3600000, 15000 * 2 ** tries) });
    }
    console.error('Facebook webhook queued for retry:', err?.message || 'Unknown failure');
  }
}

export async function drainJobs(max = 60) {
  const snap = await database().ref('serverIntegrations/facebook/webhookJobs').get();
  if (!snap.exists()) return 0;
  const jobs = [];
  snap.forEach(page => page.forEach(child => {
    const job = child.val();
    if (job && (job.status === 'queued' || (job.status === 'processing' && job.leaseUntil < Date.now()))) {
      jobs.push({ ref: child.ref, job });
    }
  }));
  jobs.sort((a, b) => a.job.createdAt - b.job.createdAt);
  const selected = jobs.slice(0, Math.min(max, 6));
  // Three concurrent sends bound API traffic and keep the worker within a serverless execution window.
  for (let i = 0; i < selected.length; i += 3) {
    await Promise.allSettled(selected.slice(i, i + 3).map(item => runJob(item.ref, item.job)));
  }
  return selected.length;
}
