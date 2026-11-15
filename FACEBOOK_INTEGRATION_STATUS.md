# Facebook Pages integration — implementation status

## Implemented in this source package

- OAuth authorization with CSRF-resistant single-use state bound to a verified Firebase user; supports classic Facebook Login and Facebook Login for Business configuration IDs.
- Automatic paginated `/me/accounts` Page discovery, one selected Page per account, and Page webhook subscription.
- AES-256-GCM encryption of user/Page tokens at rest; access tokens never returned in the Studio status API.
- Post list, create, edit, Meta-permitting delete, native Meta scheduled publish, scheduled-post list and scheduled-post deletion attempts.
- Messenger webhook signature verification, persisted queue with retries, deduplication, Page-scoped conversation storage, opt-in Gemini automated responses, 24-hour send-window enforcement, and manual reply inbox.
- Vapi voice-agent tools to read and manage Page posts, schedule posts, and read/respond to inbound Messenger chats with owner confirmation.
- Updated Facebook card directly beneath WhatsApp; server env template, deployment guide and unit tests.

## Validation completed in container

- `npm run test:facebook`: **7/7 passed** (cryptography, HMAC, credential redaction, Page post ownership, Meta form payload, OAuth modes, scheduling constraints).
- All added server-side JS: passed `node --check`.
- Studio JSX: parsed successfully with TypeScript parser; 0 syntax diagnostics, 0 duplicate element IDs.

## Not yet validated / external prerequisites

- Live Facebook OAuth/Pages selection/Meta Webhooks/Messenger Post/Send API: requires Meta app ID, secret, approved scope set, user grant, test Page and HTTPS deployment; credentials not included.
- Full Next.js build: Node.js available in the artifact environment is v22, while this repository requires Node >=24.12; dependencies aren't installed and network package downloads aren't available here.
- No GitHub commit/push or Vercel deploy has been performed from this package. Apply the included patch to the correct repository revision, configure secrets and run CI before shipping.
- Reliable queue retry requires scheduling authenticated `GET /api/facebook/jobs` (e.g. every five minutes) and `CRON_SECRET`.
- Meta may restrict post deletion even with `pages_manage_posts` scope; support cannot be guaranteed by the application.
- Not yet implemented: image/video/reels posting, comment moderation, Messenger rich-media attachments, bulk outbound messaging, arbitrary Facebook Page settings edit, cross-provider Instagram integration, and authenticated Meta data deletion callback.
