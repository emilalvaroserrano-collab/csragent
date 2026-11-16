# Canva integration — implementation and deployment status

## Implemented in CSR Agent Studio

- `Connect to Canva` is located immediately after Facebook integration and before Gmail.
- OAuth 2.0 Authorization Code + PKCE S256; one-time 10-minute state; redirect verified against configured URI.
- OAuth credentials stored only in server environment; access/rotating refresh tokens encrypted AES-256-GCM at rest in Firebase Admin RTDB under a hash of the Firebase user ID.
- Server-side refresh lock prevents parallel token rotation; revocation/disconnection removes credentials locally and attempts Canva revocation.
- Account status and granted scopes shown in the Studio without exposing credentials.
- Designs: search/list (including pagination), get metadata and Canva edit links, create preset or custom-size designs, start exports and poll asynchronous export jobs.
- Voice-agent tools: list/get/create designs, export and poll exports, folders list/create/rename/delete, asset metadata/upload URL/update/delete, brand templates list/get, account capabilities.
- Additional preview operations: AI design generation and design comments, **disabled by default** for production/public apps.
- Vapi requests receive short-lived HMAC-signed user-scoped tool credentials. Mutating tool operations require `confirm: true` and agent prompt requires prior user confirmation.
- The APIs act **only with scopes granted by the Canva user** and only for resources that user may access; no universal Canva administrator permissions are possible.

## Production setup

1. In [Canva Developer Portal](https://www.canva.com/developers/), create/configure a public integration, enable REST API, register the callback URL `https://YOUR_DOMAIN/api/canva/callback`, and choose/submit the default scopes for app review as needed. See [Canva OAuth](https://www.canva.dev/docs/apps/rest-apis/authentication/) and [OAuth scopes](https://www.canva.dev/docs/apps/rest-apis/scopes/).
2. Configure `CANVA_CLIENT_ID`, `CANVA_CLIENT_SECRET`, `CANVA_REDIRECT_URI`, `CANVA_TOKEN_ENCRYPTION_KEY`, `CANVA_TOOL_SIGNING_SECRET` in server environment. Generate fresh independent secrets (`openssl rand -hex 32` each). Configure `APP_URL`, `FIREBASE_SERVICE_ACCOUNT_JSON`, and existing Firebase/Vapi settings.
3. Configure exact permitted OAuth scopes in Developer Portal (and optionally `CANVA_SCOPES`). Defaults: `asset:read asset:write brandtemplate:content:read brandtemplate:meta:read design:content:read design:content:write design:meta:read folder:read folder:write profile:read`.
4. Deploy to an HTTPS origin with Node >=24.12 and let user click `Connect to Canva`. Verify consent, design listing, create, export and auto-refresh with a real Canva account. Test Vapi tool calls only after authenticating and consenting.
5. For publicly distributed integrations, complete Canva's required review and avoid preview endpoints. Leave `CANVA_ENABLE_PREVIEW_GENERATION=false` and `CANVA_ENABLE_PREVIEW_COMMENTS=false`.

## Scope and limitations

- Canva REST API covers supported design creation, listing, exports, assets, templates, and folder management. It does **not** provide arbitrary element-by-element editing of all existing Canva designs. Rich page, typography, image placement, and other editor operations require a separate supported Canva MCP pathway and any applicable permissions, plan access, and product availability.
- Brand templates and premium assets depend on user Canva plan and Canva's permissions.
- Public apps using Canva **preview APIs** are not eligible for Canva app review while using those preview endpoints. Both preview operations are opt-in and disabled by default.
- This source is implementation-ready, **not live OAuth-tested or deployed**. Real Meta, Canva, Firebase, and Vapi credentials and public app review are external prerequisites.
- Run `npm run test:canva` and `node --experimental-vm-modules --test tests/facebook.test.mjs`. The full Next.js build requires Node >=24.12 and installed dependencies.
