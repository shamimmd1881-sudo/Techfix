# TechFix — Telegram Bot Integration

This project connects the existing TechFix Firebase/Firestore admin data to a private Telegram bot.

## What it does

- 🔔 New **Contact Messages** → Telegram notification
- ✉️ Reply to a Contact notification in Telegram → sends an email reply (SMTP required)
- 🔔 New **Appointments** → Telegram notification with all appointment details
- 🟢 Appointment status can be changed from Telegram with `/status ...`
- 💬 New **Live Chat** visitor message → Telegram notification
- ↩️ Reply directly to that Telegram notification → message is written to the existing Firestore live chat and appears on the website immediately
- Keeps the existing `login-admin.html` and Firebase collections (`contacts`, `appointments`, `live_chats`) intact
- `/start` shows the Telegram chat ID needed for secure admin access

The uploaded admin panel already contains Contact Messages, Appointments and real-time Live Chat backed by Firestore, so the bridge listens to those existing collections rather than replacing the panel. See the existing panel's Contact Messages and Live Chat sections. 

## Folder

```
techfix-telegram-integration/
├─ public/
│  └─ login-admin.html       # your supplied admin panel
├─ server.js                 # Telegram + Firebase bridge
├─ package.json
├─ .env.example
├─ README.md
└─ serviceAccountKey.json    # YOU create this locally; do not upload/commit it
```

## Setup

### 1. Create the Telegram bot

Open Telegram and talk to **@BotFather**.

1. Run `/newbot`.
2. Choose a bot name and username.
3. Copy the bot token.

### 2. Find your Telegram admin chat ID

Start the bot and send `/start`.
It will show your chat ID.

### 3. Create Firebase service-account credentials

In Firebase Console for your existing project:

**Project settings → Service accounts → Firebase Admin SDK → Generate new private key**.

Save the downloaded JSON as:

```
serviceAccountKey.json
```

inside this project folder.

Never put this JSON in a public website or Git repository.

### 4. Configure `.env`

Copy `.env.example` to `.env` and fill in:

```
TELEGRAM_BOT_TOKEN=...
ADMIN_TELEGRAM_CHAT_ID=...
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json
```

For Contact-message email replies, also configure SMTP. For Gmail, use a Google App Password rather than your normal password.

### 5. Install and run

```bash
npm install
npm start
```

You should see:

```text
[Telegram] Bot polling started.
[HTTP] http://localhost:3000
[Bridge] Ready. Telegram + Firestore listeners active.
```

## Telegram workflow

### Live chat

When a website visitor sends a message:

1. You receive a Telegram message.
2. Tap **Reply** on that Telegram message.
3. Type your response.
4. The response is written into:

```
live_chats/{chatId}/messages
```

with `sender: admin`, so the visitor sees it through the existing live-chat UI.

### Contact messages

When a contact form message arrives, Telegram shows the sender, email, subject and message.
Reply to the Telegram notification and the bridge sends the reply by email.

### Appointments

Telegram receives the appointment reference, customer contact, service, date, time and notes.
Reply to the appointment notification with one of:

```
/status New
/status Contacted
/status Completed
/status Cancelled
```

The status is updated in:

```
apppointments/{documentId}
```

## Important deployment note

The bridge must run continuously for Telegram notifications and real-time replies. A normal static-hosting deployment cannot run this Node process.

Suitable hosts include a VPS or a Node-capable service such as Render, Railway, Fly.io, or similar. Set the same environment variables there and upload the Firebase service-account credentials securely (prefer the host's secret/credential mechanism rather than a public file).

## Security

- Do not expose `TELEGRAM_BOT_TOKEN` in frontend JavaScript.
- Do not expose `serviceAccountKey.json` publicly.
- Keep `ADMIN_TELEGRAM_CHAT_ID` set to your own Telegram chat ID.
- Keep Firebase Firestore security rules locked down appropriately.
- If a bot token is ever leaked, revoke/regenerate it in BotFather immediately.
