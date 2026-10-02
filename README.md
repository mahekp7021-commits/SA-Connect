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
