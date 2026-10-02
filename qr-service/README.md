# S&A Connect — Real WhatsApp QR Service

This service creates a real WhatsApp linked-device session using WhiskeySockets/Baileys.

## Important

This is for development/testing first. Baileys is an unofficial WhatsApp Web library and is not affiliated with WhatsApp. Use it responsibly and in accordance with WhatsApp's Terms of Service.

## Requirements

- Node.js 20+
- A test WhatsApp account/number
- Do not use a personal/production client number during initial testing.

## Local setup

From this folder:

    npm install

Windows PowerShell:

    $env:QR_SERVICE_KEY="CHANGE_THIS_TO_A_LONG_RANDOM_SECRET"
    npm start

The service listens on:

    http://localhost:10000

Health check:

    GET http://localhost:10000/health

## API

Every QR API request requires:

    x-qr-service-key: <QR_SERVICE_KEY>
    x-client-id: <S&A Connect clientId>

### Start

    POST /api/qr/start

### Status

    GET /api/qr/status

The response contains:

- status
- qr — data URL for the real QR image while waiting for scan
- phone
- name
- lastError

### Logout

    POST /api/qr/logout

### Send text

    POST /api/qr/send

JSON:

    {
      "phone": "919699907771",
      "message": "Hello from S&A Connect"
    }

## Session storage

Development uses:

    qr-service/sessions/<clientId>/

These files contain WhatsApp authentication credentials and must never be committed to GitHub.

For production, replace the development file-based auth state with persistent storage. Baileys documentation warns that useMultiFileAuthState is a development-oriented utility.

## Firebase sync

If FIREBASE_SERVICE_ACCOUNT_JSON is configured, the service also writes QR connection status and QR-originated messages into:

- whatsappQrConnections
- whatsappMessages
- whatsappConversations

The service never puts WhatsApp credentials into the Android APK.

## Render testing

Render currently offers free web services for testing, but free services can spin down after inactivity and their local filesystem is ephemeral. Treat a free Render deployment as a test environment, not the final production WhatsApp session host.
