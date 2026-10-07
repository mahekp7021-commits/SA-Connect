# S&A Connect

**Business Communication & CRM**

## Stack
- GitHub — source control
- Firebase Hosting — public landing pages
- Firebase Cloud Functions (2nd gen) — secure API
- Firebase Authentication + Cloud Firestore — CRM backend

Firebase project: `sa-connect-844ce`

## Public URLs
- Main site: `https://sa-connect-844ce.web.app/`
- Client landing page pattern: `/l/<slug>`

Example:
`https://sa-connect-844ce.web.app/l/saanvi_mediaworks`

## API
Hosting rewrites `/api/**` to the Firebase HTTPS function `api`, which routes internally to the S&A Connect endpoints.

## Security
Never commit service-account JSON, WhatsApp access tokens, Meta secrets, or encryption keys.

## Deployment
Install Firebase CLI, authenticate to the Firebase account that owns `sa-connect-844ce`, then run:
`firebase deploy --only hosting,functions,firestore:rules`


## WhatsApp Cloud API webhook

The WhatsApp webhook is handled by the existing Firebase HTTP function `api`; Netlify is not required.

Webhook callback URL for Meta:
`https://asia-south1-sa-connect-844ce.cloudfunctions.net/api/api/whatsapp-webhook`

For local/deployment configuration, keep these values in `functions/.env` and never commit that file:

```env
META_WA_VERIFY_TOKEN=your_meta_webhook_verify_token
META_APP_SECRET=your_meta_app_secret
WHATSAPP_TOKEN_ENCRYPTION_KEY=your_long_random_secret
```

After configuring the values, deploy from the repository root:

```bash
firebase deploy --only functions,hosting,firestore:rules
```

The webhook maps Meta's `phone_number_id` to `whatsappConnections/{phoneNumberId}`. Incoming WhatsApp messages are then stored in `whatsappMessages` and `whatsappConversations`, and a matching CRM lead is created/updated in `leads` with source `whatsapp_api`. A `leadTimeline` entry is also created.

Meta webhook verification must use the same value as `META_WA_VERIFY_TOKEN`.
