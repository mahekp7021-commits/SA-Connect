# S&A Connect OpenWA Bridge

Render Web Service used for the S&A Connect multi-client bridge.

## Incoming WhatsApp

POST /webhook/openwa

OpenWA sends `message.received`. The receiver verifies the OpenWA HMAC signature and writes:

- `whatsappMessages`
- `whatsappConversations`
- `leads`
- `leadTimeline`

## Client management

GET /api/admin/clients

POST /api/admin/clients

These endpoints require a Firebase ID token in:

`Authorization: Bearer <firebase-id-token>`

The token email must be present in `SA_CONNECT_SUPER_ADMIN_EMAILS`.

Creating a client creates:

- `clients/{clientId}`
- a Firebase Authentication user
- `users/{uid}` with the generated `clientId` and `role: admin`

The client receives a unique `clientId`, so leads, inbox messages and landing-page data remain tenant-isolated.

## CRM -> WhatsApp reply

POST /api/whatsapp/send

JSON body:

```json
{
  "clientId": "client-id",
  "phone": "919xxxxxxxxx",
  "message": "Hello from CRM",
  "sessionId": "sa-connect"
}
```

The service calls OpenWA:

`POST /api/sessions/{sessionId}/messages/send-text`

and records the outbound message in `whatsappMessages` and `whatsappConversations`.

## Required Render environment variables

- FIREBASE_SERVICE_ACCOUNT_JSON
- SA_CONNECT_SUPER_ADMIN_EMAILS
- OPENWA_WEBHOOK_SECRET
- OPENWA_BASE_URL
- OPENWA_API_KEY
- OPENWA_SESSION_ID (defaults to `sa-connect`)

For a single fixed OpenWA session/client, `SA_CONNECT_CLIENT_ID` may also be set for incoming webhook routing.

## OpenWA webhook

URL:

`https://<your-render-service>.onrender.com/webhook/openwa`

Event:

`message.received`

Secret:

Use the same value as `OPENWA_WEBHOOK_SECRET`.

## Important

This uses OpenWA, an unofficial WhatsApp Web bridge. It is not the official Meta Cloud API and carries account/session risk. Render Free also has ephemeral storage and idle spin-down, so this is suitable for testing and early development, not guaranteed 24/7 production availability.


## Official Meta WhatsApp Business Platform (separate provider)

The official Meta Cloud API is separate from OpenWA. It uses the client's Meta Phone Number ID and access token; the token is encrypted with AES-256-GCM before it is stored by the backend. The raw access token is never returned by the configuration endpoint.

Authenticated client endpoints (Firebase ID token required):

- `GET /api/whatsapp/meta/config` — read non-secret configuration status
- `POST /api/whatsapp/meta/config` — save `phoneNumberId`, optional `wabaId`, optional `displayPhoneNumber`, and `accessToken`
- `POST /api/whatsapp/meta/send` — send a text message using the current user's linked client workspace
- `POST /api/whatsapp/meta/disconnect` — remove that client's stored Meta credentials
- `GET /webhook/meta` — Meta webhook verification
- `POST /webhook/meta` — signed inbound messages and delivery statuses

For each client's Meta app/WABA setup, configure the callback URL as `https://<render-service-host>/webhook/meta` and the verify token as the value in `META_WEBHOOK_VERIFY_TOKEN`. Subscribe the WABA to the `messages` webhook field. The Meta app secret must be configured in `META_APP_SECRET` so the receiver can verify `X-Hub-Signature-256`.

### Additional Render environment variables

- `PUBLIC_API_BASE_URL` — public base URL of this Render webhook service, without a trailing slash
- `META_APP_SECRET` — Meta App Secret used to validate webhook signatures
- `META_WEBHOOK_VERIFY_TOKEN` — private string used only for Meta's webhook handshake
- `META_CREDENTIAL_ENCRYPTION_KEY` — random 32-byte key represented as 64 hexadecimal characters; keep it stable or existing encrypted tokens cannot be decrypted
- `META_GRAPH_API_VERSION` — optional Graph API version, for example `v23.0`

Generate the encryption key in a secure terminal using `openssl rand -hex 32`. Never commit the key, service account JSON, Meta access tokens, OpenWA API key, or webhook secrets.

## OpenWA QR connection (separate provider)

- `POST /api/whatsapp/openwa/connect` creates a session for the authenticated client's workspace and registers its webhook.
- `GET /api/whatsapp/openwa/status` checks that client's session.
- `GET /api/whatsapp/openwa/qr` retrieves that session's QR image.
- `POST /api/whatsapp/openwa/send` sends through that client's OpenWA session.

OpenWA session documents are stored in `openwaSessions/{sessionId}` with a `clientId`. Incoming routing checks this mapping first. Do not set `SA_CONNECT_CLIENT_ID`. Unmapped OpenWA sessions are rejected rather than routed to a default tenant.

The Android app's integration screen is available from More → Official WhatsApp Business API and More → WhatsApp QR Connection. The Firebase-hosted integration settings page is also served at `/whatsapp`.
