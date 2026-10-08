# S&A Connect OpenWA Webhook Receiver

Small Render Web Service that receives OpenWA `message.received` webhooks and writes incoming messages into the existing S&A Connect Firestore collections.

## Endpoint

POST /webhook/openwa

Health:
GET /health

## Required environment variables

- FIREBASE_SERVICE_ACCOUNT_JSON
- SA_CONNECT_CLIENT_ID
- OPENWA_WEBHOOK_TOKEN

Optional:
- OPENWA_SESSION_ID (defaults to sa-connect)

The OpenWA webhook should send the header:

X-Webhook-Token: <same OPENWA_WEBHOOK_TOKEN>

Subscribe only to:
message.received

This receiver is intentionally separate from the Firebase Cloud Functions deployment so the existing S&A Connect Firebase project can remain on the Spark plan.
