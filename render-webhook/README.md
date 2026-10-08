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
