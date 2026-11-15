# CSR Studio

Next.js app for building a customer-service voice persona and testing it with a
Vapi browser call. Signed-out visitors are sent to `/auth`; signed-in users get
the studio at `/`.

## Local development

```bash
cp .env.example .env   # fill in Firebase and Vapi values
npm install
npm run dev            # http://localhost:3000
```

## Environment variables

All configuration is read on the server from environment variables. Nothing is
hardcoded in the repo, and no `NEXT_PUBLIC_*` values are used.

| Variable | Purpose |
| --- | --- |
| `FIREBASE_API_KEY` | Firebase web API key |
| `FIREBASE_AUTH_DOMAIN` | Firebase Auth domain |
| `FIREBASE_DATABASE_URL` | Realtime Database URL |
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_STORAGE_BUCKET` | Storage bucket |
| `FIREBASE_MESSAGING_SENDER_ID` | Messaging sender ID |
| `FIREBASE_APP_ID` | Web app ID |
| `FIREBASE_MEASUREMENT_ID` | Analytics measurement ID |
| `VAPI_PUBLIC_KEY` | Vapi public web key |
| `VAPI_ASSISTANT_ID` | Vapi assistant ID |

Set these in Vercel under **Settings → Environment Variables** for Production,
Preview, and Development.

## How it works

- `app/page.js` — server page; reads config and renders the studio.
- `app/auth/page.js` — server page; reads config and renders sign-in.
- `components/StudioApp.js` — studio UI, persona storage, call flow.
- `components/AuthApp.js` — sign-in/sign-up, password reset, redirects.
- `app/api/vapi-overrides/route.js` — verifies the Firebase ID token, then
  builds the transient assistant overrides (system prompt, knowledge, voice).
- `lib/agent-overrides.js` — server-only prompt hydration and validation.
- `lib/agent-system-prompt.json` — master system prompt; server bundle only.

The master system prompt is never included in client JavaScript. The browser
only sends the persona fields and receives the assembled overrides from the API.

## Deploy

The app deploys to Vercel as a standard Next.js project:

```bash
vercel --prod
```

Production: <https://callie-ochre.vercel.app>

## WhatsApp call reports

After a call finishes, CSR Studio can send a transcript summary to the agent owner's
WhatsApp. This requires a small Baileys bridge that runs as a separate long-lived
service (Vercel cannot host the persistent WhatsApp socket). The bridge is provided
in `whatsapp-service/` and ships with a Dockerfile.

### Environment variables

Add these to Vercel (and to the bridge's `.env`):

| Variable | Purpose |
| --- | --- |
| `WHATSAPP_SERVICE_URL` | Public HTTPS URL of the Baileys bridge (no trailing slash) |
| `WHATSAPP_SERVICE_SECRET` | Shared secret between Next.js and the bridge (>= 16 chars) |

### Run the bridge with Docker

```bash
cp whatsapp-service/.env.example whatsapp-service/.env
# set WHATSAPP_SERVICE_SECRET to the same value used in Vercel
openssl rand -hex 32  # paste into both .env files

docker compose up -d --build
```

The compose file binds the service to `127.0.0.1:8080`. For Vercel to reach it,
expose it through a reverse proxy (Caddy, Nginx, or a tunnel) and set
`WHATSAPP_SERVICE_URL` to that public HTTPS URL. Example Caddyfile:

```caddy
whatsapp.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Auth state is persisted in the `whatsapp_data` Docker volume, so linked sessions
survive container restarts.

### How it works

- `app/api/whatsapp/session` — verifies the Firebase ID token, then proxies to
  the bridge (QR or pairing-code link, status, disconnect, logout).
- `app/api/whatsapp/send` — sends an arbitrary message through the linked account.
- `app/api/whatsapp/report` — builds a call summary server-side from call metadata
  and the transcript, then sends it. The master system prompt is never involved.
- `components/StudioApp.js` — WhatsApp card in the studio with status, modal, auto-send
  toggle, optional destination number, and a test action. On `call-end`, a summary is
  sent when auto-send is enabled and the call connected.
EOF

## Facebook Pages integration (OAuth, post CRUD, scheduling, Messenger)

A new **Facebook Pages & Messenger** card appears immediately under the WhatsApp integration. The current signed-in Firebase user authorizes Meta, sees their managed Facebook Pages, selects **one Page** for this CSR account, and can enable incoming Messenger AI auto-replies.

### 1. Meta App Dashboard setup

1. Create a **Meta Business app**, add **Facebook Login for Business** (or the supported Facebook Login product), and configure its **Valid OAuth Redirect URI** to exactly `https://YOUR_DOMAIN/api/facebook/callback`. Set the app domain and any required verified business details in Meta.
2. Request these permissions in the Login configuration and submit for **Advanced Access / App Review** when onboarding people outside the app's development/test roles:
   - `pages_show_list` (managed Page discovery)
   - `pages_read_engagement` (reading Page-owned content)
   - `pages_manage_posts` (post creation / editing / eligible deletions)
   - `pages_manage_metadata` (subscribing the Page to webhooks)
   - `pages_messaging` (Messenger)
3. Create a **Webhooks > Page** subscription with callback `https://YOUR_DOMAIN/api/facebook/webhook` and verify token matching `FACEBOOK_WEBHOOK_VERIFY_TOKEN`. Subscribe to `messages` (and `messaging_postbacks` if used). The app subscribes the selected Page to those fields by calling `/{page-id}/subscribed_apps` after selection.
4. Set `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, optional `FACEBOOK_LOGIN_CONFIG_ID`, `FACEBOOK_REDIRECT_URI`, `FACEBOOK_GRAPH_VERSION` (default `v27.0`), `FACEBOOK_WEBHOOK_VERIFY_TOKEN`, and `FACEBOOK_TOKEN_ENCRYPTION_KEY` on Vercel. Use two different random secrets:

```bash
openssl rand -hex 32 # FACEBOOK_WEBHOOK_VERIFY_TOKEN
openssl rand -hex 32 # FACEBOOK_TOKEN_ENCRYPTION_KEY
```

5. For automatic Messenger replies, set `GEMINI_API_KEY`. Optional `GEMINI_MODEL` defaults to `gemini-2.5-flash`.
6. Set `APP_URL=https://YOUR_DOMAIN` so server-side Vapi tool callbacks target the correct public domain.

**Important:** Grant Meta the app's required access before expecting external customer Pages to appear. For **Facebook Login for Business**, create a configuration containing the permissions, choose a **person-derived user token** (not a system-user token for Messenger), and set `FACEBOOK_LOGIN_CONFIG_ID`. If this is set, the login flow uses `config_id` instead of a URL `scope` parameter. In Meta Development Mode, only app-role test users can connect. A Facebook account without the appropriate Page task access (including `MESSAGING` for Messenger) cannot subscribe that Page to receive messages.

### 2. Connect and use

Open CSR Studio → **Connect Facebook** → approve the Facebook authorization dialog → choose a Page in the selector. Facebook returns the managed Pages through paginated `GET /me/accounts`. Only the selected Page is connected to the agent. The Page token and long-lived user token are encrypted with AES-256-GCM and kept **server-side** in Firebase Admin RTDB; the browser receives only Page metadata.

From the Page card:

- Create, list, edit, and attempt to delete text posts. Meta may deny deletion for some apps/developers even with the permission.
- Schedule a post natively on Meta for 10 minutes to 75 days ahead (no custom content scheduler needed). View and attempt to cancel scheduled Page posts.
- View recent incoming Messenger conversations and send a manual reply within 24 hours of the customer's latest message.
- Turn on **Automatically reply** to let Gemini generate a short customer-support response using the saved CSR persona and available website knowledge. Off by default; messages are limited to customer-initiated conversations.
- Disconnect and revoke the integration's local credentials, disabling automation. For full permission revocation, remove the app in Facebook's account integrations settings as well.

With Facebook connected, Vapi voice sessions also gain explicit Facebook function tools for post CRUD, scheduled posts, recent conversations, and customer replies. Publishing, modifying, deleting, and manual sending require the owner to approve an action; this is enforced conversationally with a `confirm` parameter in the tool interface. Automatic Messenger replies are controlled independently by the checkbox.

### 3. Reliable Messenger webhook processing

`POST /api/facebook/webhook` verifies Meta's `X-Hub-Signature-256`, persists text events to a Firebase queue, acknowledges Meta, and processes queued events using Next.js `after()`. Delivery deduplication uses the inbound Meta message ID. A failed worker job remains queued for retry; the authenticated server worker is `GET /api/facebook/jobs` with `Authorization: Bearer $CRON_SECRET`.

**Production requirement:** schedule `GET /api/facebook/jobs` every 1–5 minutes through your supported scheduler (for example, Vercel Cron if your plan supports the required frequency, or Cloud Scheduler), with `CRON_SECRET` configured. A scheduler is important for recovery from interrupted invocations; without it, retries depend on new events invoking the worker.

Example Vercel Cron configuration on a plan supporting 5-minute schedules (add the following `crons` entry to `vercel.json` only if supported by your Vercel plan):

```json
{ "crons": [{ "path": "/api/facebook/jobs", "schedule": "*/5 * * * *" }] }
```

Restrict Firebase RTDB paths under **`serverIntegrations/facebook/`** to admin-only server access in the RTDB Security Rules, e.g.:

```json
{
  "rules": {
    "serverIntegrations": {
      "facebook": { ".read": false, ".write": false }
    }
  }
}
```

*Merge these restrictions into your existing Firebase rules; do not overwrite unrelated rules.* `firebase-admin` bypasses client rules. Never store Meta app secrets, Facebook access tokens, or encryption keys in client-side configuration. Rotate an exposed key and reconnect affected Facebook accounts.

### 4. Testing and known limitations

```bash
npm run test:facebook
npm ci
npm run build
```

Automated unit tests cover encryption, signed webhook and tool tokens, token redaction and Page post ownership. Live OAuth/Webhooks/Post/Send API flows require **your Meta app credentials**, authorized Pages, an HTTPS deployment, and real API review/permissions; those cannot be validated with placeholders. Messenger attachments, rich templates, comment moderation, Instagram, and automatic bulk outbound marketing are **not** included. Meta messaging outside the standard customer-initiated 24-hour window requires separate compliant features/permissions. Meta platform limits and Page-level access always prevail over the app UI.
