# TechFix — Telegram Admin Bridge

Connects the TechFix Firebase/Firestore data to a private Telegram bot, so you
can manage live chat, contact messages, and appointments without opening the
web admin panel.

**This is one of two separate deployments:**
1. **This project** (`techfix-telegram-integration`) → an always-on Node
   process (Suga, a VPS, etc.) — the Telegram bridge only.
2. **The website** (`techfix24-site`) → deployed on **Netlify** — the public
   pages, `login-admin.html`, `firestore.rules`, and the appointment
   confirmation-email function. See that project's own notes for setup.

They talk to each other only through the shared Firestore database — neither
needs to know the other's URL.

## What it does

- 🔔 New **Contact Message** → Telegram notification → reply to it to send an email reply (SMTP required)
- 🔔 New **Appointment** → Telegram notification → `/status Contacted|Completed|Cancelled` as a reply to update it
- ⏳ An appointment nobody actions within 5 days of its scheduled time is **auto-cancelled**, with a Telegram notice
- 💬 New **Live Chat** message → Telegram notification (visitor, email, message only)
- 📋 `/chats` — browse every live-chat visitor, pin/rename/delete, or select one to message directly (shows chat history, no need to swipe-reply)
- 📣 `/broadcast <message>` — message every live-chat visitor at once
- 🧹 Contact messages, resolved appointments, and old chat messages **auto-delete after 30 days** to keep storage costs down
- Exactly-once notification delivery even if a redeploy briefly overlaps two instances

## Folder

```
techfix-telegram-integration/
├─ server.js                 # Telegram + Firebase bridge (no static files — Netlify serves the site)
├─ package.json
├─ Dockerfile                # for container hosts (Suga, etc.)
├─ .dockerignore
├─ .gitignore
├─ .env.example
└─ serviceAccountKey.json    # YOU create this locally; never commit/upload it
```

## Setup

### 1. Create the Telegram bot
Talk to **@BotFather** on Telegram → `/newbot` → copy the bot token.

### 2. Find your admin chat ID
Message your new bot `/start` — it replies with your chat ID.

### 3. Firebase credentials
Firebase Console → Project settings → Service accounts → **Generate new private key**.

- **Local machine / VPS:** save it as `serviceAccountKey.json` next to `server.js`, set `GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json` in `.env`.
- **Container hosts with no file upload (Suga, Railway, Fly, Render, etc.):** base64-encode it and set `FIREBASE_SERVICE_ACCOUNT_BASE64` instead — see `.env.example` for the exact command.

### 4. Configure environment variables
Copy `.env.example` to `.env` (local use) or set the same keys in your host's dashboard:
```
TELEGRAM_BOT_TOKEN=...
ADMIN_TELEGRAM_CHAT_ID=...
FIREBASE_SERVICE_ACCOUNT_BASE64=...
```
Add `SMTP_*` variables too if you want Contact Message replies to send real emails.

### 5. Install and run
```bash
npm install
npm start
```
Expected output:
```text
[Telegram] Bot polling started.
[HTTP] http://localhost:3000
[Bridge] Ready. Telegram + Firestore listeners active.
```

### 6. Publish the Firestore rules (from the site project)
`firestore.rules` lives in the **website** project now, not here — the bridge uses the Firebase Admin SDK, which bypasses rules entirely. But the website (`login-admin.html`, the live chat widget, the appointment form) is subject to them, so make sure that file has actually been pasted into **Firebase Console → Firestore Database → Rules → Publish**. A rules file just sitting in a repo does nothing until published.

## Telegram commands

| Command | What it does |
|---|---|
| `/start` | Shows your chat ID |
| `/help` | Lists all commands |
| `/chats` | Lists all live-chat visitors with pin/rename/delete/message buttons |
| `/stopchat` | Exits "messaging" mode selected from `/chats` |
| `/broadcast <msg>` | Sends `<msg>` to every live-chat visitor |
| `/status <New\|Contacted\|Completed\|Cancelled>` | As a reply to an appointment notification, updates its status |
| (reply to any notification) | Contact → emails your reply back; Live chat → sends it to that visitor |

## Deployment note

This must run as a continuously-alive process — no serverless/static host will
keep the Telegram polling and Firestore listeners running. See the Dockerfile
for container-based hosts. Keep only **one instance** running; the bridge
includes duplicate-notification protection, but two long-running copies is
still wasted resources and can occasionally race on Telegram's own polling.

## Security

- Never expose `TELEGRAM_BOT_TOKEN` or the Firebase service-account key in any frontend code.
- Keep `ADMIN_TELEGRAM_CHAT_ID` set to your own Telegram chat ID.
- If the bot token ever leaks, revoke/regenerate it in BotFather immediately.
- The service-account key grants full Firestore admin access — rotate it via Firebase Console if it's ever exposed.
