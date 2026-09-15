require('dotenv').config();
const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = String(process.env.ADMIN_TELEGRAM_CHAT_ID || '').trim();

if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');

// --- Firebase Admin credentials ---
// Most container hosts (Suga, Railway, Fly, Render, etc.) only let you set
// environment variables, not upload a private serviceAccountKey.json file.
// So we support three ways to provide credentials, in this order:
//   1. FIREBASE_SERVICE_ACCOUNT_BASE64  - the whole JSON key, base64-encoded
//   2. FIREBASE_SERVICE_ACCOUNT_JSON    - the whole JSON key, raw (paste-as-is)
//   3. GOOGLE_APPLICATION_CREDENTIALS   - path to a local JSON file (for local/VPS use)
function loadFirebaseCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    try {
      const json = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
      return admin.credential.cert(JSON.parse(json));
    } catch (e) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 is set but could not be decoded/parsed as JSON: ' + e.message);
    }
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
    } catch (e) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON: ' + e.message);
    }
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return admin.credential.applicationDefault();
  }
  throw new Error(
    'Missing Firebase credentials. Set one of: FIREBASE_SERVICE_ACCOUNT_BASE64, ' +
    'FIREBASE_SERVICE_ACCOUNT_JSON, or GOOGLE_APPLICATION_CREDENTIALS in your environment.'
  );
}

admin.initializeApp({ credential: loadFirebaseCredential() });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true, service: 'techfix-telegram-bridge' }));
app.use(express.static(path.join(__dirname, 'public')));

const mailer = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || 'true') === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  : null;

function isAdmin(msg) {
  return !!ADMIN_CHAT_ID && String(msg.chat.id) === ADMIN_CHAT_ID;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtTime(v) {
  if (!v) return '—';
  try {
    if (v.toDate) return v.toDate().toLocaleString('en-BD', { timeZone: 'Asia/Dhaka' });
    return new Date(v).toLocaleString('en-BD', { timeZone: 'Asia/Dhaka' });
  } catch (_) { return String(v); }
}
function cleanText(s, max = 3500) {
  return String(s ?? '').replace(/\r/g, '').trim().slice(0, max);
}
function commandArgs(text) {
  return String(text || '').replace(/^\/\w+(?:@\w+)?\s*/i, '').trim();
}

async function sendAdmin(text, opts = {}) {
  if (!ADMIN_CHAT_ID) {
    console.warn('[Telegram] ADMIN_TELEGRAM_CHAT_ID is not configured. Notification skipped.');
    return null;
  }
  return bot.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: 'HTML', ...opts });
}

const replyMap = new Map(); // Telegram message id -> {type, id, email, subject}  (fast in-memory cache)
const activeChatListeners = new Map();
let startedAt = new Date();
let bootReady = false;

// --- Persistent backup of the reply map, so replies still work even if the
// server restarted after the notification was sent (in-memory Map alone
// does NOT survive a restart, which silently breaks "reply to notification"). ---
const REPLY_MAP_COLLECTION = 'tg_reply_map';

async function rememberReplyTarget(telegramMessageId, target) {
  replyMap.set(telegramMessageId, target);
  try {
    await db.collection(REPLY_MAP_COLLECTION).doc(String(telegramMessageId)).set({
      ...target,
      createdAt: FieldValue.serverTimestamp()
    });
  } catch (e) {
    // Non-fatal: in-memory map still works until the next restart.
    console.error('[tg_reply_map] Failed to persist reply target:', e.message);
  }
}

async function getReplyTarget(telegramMessageId) {
  if (replyMap.has(telegramMessageId)) return replyMap.get(telegramMessageId);
  try {
    const doc = await db.collection(REPLY_MAP_COLLECTION).doc(String(telegramMessageId)).get();
    if (doc.exists) {
      const target = doc.data();
      replyMap.set(telegramMessageId, target); // warm the cache
      return target;
    }
  } catch (e) {
    console.error('[tg_reply_map] Failed to look up reply target:', e.message);
  }
  return null;
}

async function notifyContact(id, data) {
  const msg = await sendAdmin(
    `📩 <b>New Contact Message</b>\n\n` +
    `<b>Name:</b> ${esc(data.name || '—')}\n` +
    `<b>Email:</b> ${esc(data.email || '—')}\n` +
    `<b>Subject:</b> ${esc(data.subject || '—')}\n\n` +
    `<b>Message:</b>\n${esc(cleanText(data.message))}\n\n` +
    `↩️ Reply to this Telegram message to reply by email.`
  );
  if (msg) await rememberReplyTarget(msg.message_id, { type: 'contact', id, email: data.email || '', subject: data.subject || 'Your message' });
}

async function notifyAppointment(id, data) {
  const msg = await sendAdmin(
    `📅 <b>New Appointment</b>\n\n` +
    `<b>Reference:</b> ${esc(data.referenceNumber || id)}\n` +
    `<b>Name:</b> ${esc(data.name || '—')}\n` +
    `<b>Phone:</b> ${esc(data.phone || '—')}\n` +
    `<b>Email:</b> ${esc(data.email || '—')}\n` +
    `<b>Service:</b> ${esc(data.serviceType || '—')} ${data.serviceOption ? '— ' + esc(data.serviceOption) : ''}\n` +
    `<b>Date:</b> ${esc(data.appointmentDate || '—')}\n` +
    `<b>Time:</b> ${esc(data.appointmentTime || '—')}\n` +
    `<b>Notes:</b> ${esc(cleanText(data.problemDetails || '—'))}\n\n` +
    `Reply with <code>/status Contacted</code>, <code>/status Completed</code> or <code>/status Cancelled</code> while replying to this message.`
  );
  if (msg) await rememberReplyTarget(msg.message_id, { type: 'appointment', id });
}

async function notifyLiveMessage(chatId, chat, messageId, data) {
  if (data.sender !== 'customer') return;
  const msg = await sendAdmin(
    `💬 <b>New Live Chat Message</b>\n\n` +
    `<b>Visitor:</b> ${esc(chat.name || data.name || 'Guest')}\n` +
    `<b>Email:</b> ${esc(chat.email || '—')}\n` +
    `<b>Chat ID:</b> <code>${esc(chatId)}</code>\n\n` +
    `<b>Message:</b>\n${esc(cleanText(data.message))}\n\n` +
    `↩️ Reply directly to this Telegram message to send your reply to the website visitor.\n` +
    `(Or, if Reply doesn't work on your device: <code>/reply ${esc(chatId)} your message</code>)`
  );
  if (msg) await rememberReplyTarget(msg.message_id, { type: 'livechat', id: chatId });
}

async function replyToContact(target, text) {
  if (!mailer) throw new Error('SMTP is not configured. Add SMTP settings to .env first.');
  if (!target.email) throw new Error('This contact has no email address.');
  await mailer.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: target.email,
    subject: target.subject ? `Re: ${target.subject}` : 'Reply from TechFix',
    text
  });
  await db.collection('contacts').doc(target.id).set({
    adminReply: text,
    repliedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

async function replyToLiveChat(chatId, text) {
  const ref = db.collection('live_chats').doc(chatId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new Error(`No live chat found with id "${chatId}". It may have been deleted, or this is not the chat's document id.`);
  }
  await ref.collection('messages').add({
    sender: 'admin',
    name: 'TechFix Support',
    message: text,
    timestamp: FieldValue.serverTimestamp()
  });
  await ref.set({
    lastMessage: text,
    lastUpdated: FieldValue.serverTimestamp(),
    adminOnline: true
  }, { merge: true });
}

async function updateAppointment(id, status) {
  const allowed = ['New', 'Contacted', 'Completed', 'Cancelled'];
  if (!allowed.includes(status)) throw new Error(`Invalid status. Use: ${allowed.join(', ')}`);
  await db.collection('appointments').doc(id).update({ status });
}

bot.onText(/^\/start(?:@\w+)?$/i, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `TechFix Telegram bridge is connected.\n\nYour Telegram chat ID is: <code>${esc(msg.chat.id)}</code>\n\n` +
    `Put this value in ADMIN_TELEGRAM_CHAT_ID in .env, restart the server, and only this chat will receive/administer messages.`,
    { parse_mode: 'HTML' }
  );
});

bot.onText(/^\/help(?:@\w+)?$/i, async (msg) => {
  if (!isAdmin(msg)) return;
  await bot.sendMessage(msg.chat.id,
    `<b>TechFix controls</b>\n\n` +
    `• Reply (long-press → Reply) to a live-chat notification → send message to visitor\n` +
    `• Reply to a contact notification → send email reply\n` +
    `• Reply to an appointment notification with <code>/status Contacted</code>\n` +
    `• /status New|Contacted|Completed|Cancelled (as a reply to an appointment)\n` +
    `• /reply CHAT_ID your message — fallback if Reply doesn't work on your device`,
    { parse_mode: 'HTML' }
  );
});

bot.onText(/^\/status(?:@\w+)?\s+(.+)$/i, async (msg, match) => {
  if (!isAdmin(msg)) return;
  try {
    const replied = msg.reply_to_message;
    if (!replied) throw new Error('Use /status as a reply to an appointment notification (long-press the notification → Reply).');
    const target = await getReplyTarget(replied.message_id);
    if (!target || target.type !== 'appointment') throw new Error('That message is not mapped to an appointment.');
    await updateAppointment(target.id, match[1].trim());
    await bot.sendMessage(msg.chat.id, `✅ Appointment <code>${esc(target.id)}</code> updated to <b>${esc(match[1].trim())}</b>.`, { parse_mode: 'HTML' });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ ${esc(e.message)}`);
  }
});

// Fallback for replying to live chat when Telegram's "Reply" gesture isn't used
// (some clients/copy-paste flows don't set reply_to_message reliably).
bot.onText(/^\/reply(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/i, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const chatId = match[1].trim();
  const text = cleanText(match[2], 2000);
  try {
    await replyToLiveChat(chatId, text);
    await bot.sendMessage(msg.chat.id, `✅ Reply sent to chat <code>${esc(chatId)}</code>.`, { parse_mode: 'HTML' });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ ${esc(e.message)}`);
  }
});

bot.on('message', async (msg) => {
  if (!isAdmin(msg) || !msg.text || msg.text.startsWith('/')) return;
  const replied = msg.reply_to_message;
  if (!replied) {
    await bot.sendMessage(
      msg.chat.id,
      '⚠️ I didn\'t get that. To send a reply, long-press (or swipe on) the specific customer/contact/appointment notification and choose <b>Reply</b>, then type your message — don\'t just type a new message in the chat.\n\n' +
      'If Reply still doesn\'t register on your Telegram app, use:\n<code>/reply CHAT_ID your message</code>\n(the CHAT_ID is printed in every live-chat notification).',
      { parse_mode: 'HTML' }
    );
    return;
  }
  const target = await getReplyTarget(replied.message_id);
  if (!target) {
    await bot.sendMessage(msg.chat.id, '⚠️ This notification is no longer mapped (it may predate the bridge\'s last restart, or is too old). Use <code>/reply CHAT_ID your message</code> instead — the CHAT_ID is in the original notification.', { parse_mode: 'HTML' });
    return;
  }
  const text = cleanText(msg.text, 2000);
  try {
    if (target.type === 'livechat') {
      await replyToLiveChat(target.id, text);
      await bot.sendMessage(msg.chat.id, '✅ Reply sent to the website visitor.');
    } else if (target.type === 'contact') {
      await replyToContact(target, text);
      await bot.sendMessage(msg.chat.id, `✅ Email reply sent to ${esc(target.email)}.`, { parse_mode: 'HTML' });
    } else if (target.type === 'appointment') {
      await bot.sendMessage(msg.chat.id, 'ℹ️ This is an appointment notification — use <code>/status Contacted</code> (etc.) as a reply to change its status, not a plain text reply.', { parse_mode: 'HTML' });
    }
  } catch (e) {
    console.error('[reply handler]', e);
    await bot.sendMessage(msg.chat.id, `❌ ${esc(e.message)}`);
  }
});

function watchContacts() {
  db.collection('contacts').orderBy('timestamp', 'desc').onSnapshot(snap => {
    snap.docChanges().forEach(ch => {
      if (ch.type !== 'added') return;
      const data = ch.doc.data();
      if (bootReady && isRecent(data.timestamp)) notifyContact(ch.doc.id, data).catch(console.error);
    });
  }, err => console.error('[Firestore contacts]', err));
}

function watchAppointments() {
  db.collection('appointments').orderBy('timestamp', 'desc').onSnapshot(snap => {
    snap.docChanges().forEach(ch => {
      if (ch.type !== 'added') return;
      const data = ch.doc.data();
      if (bootReady && isRecent(data.timestamp)) notifyAppointment(ch.doc.id, data).catch(console.error);
    });
  }, err => console.error('[Firestore appointments]', err));
}

function isRecent(v) {
  if (!v) return true;
  try { return v.toDate().getTime() >= startedAt.getTime() - 30000; } catch (_) { return true; }
}

function watchLiveChats() {
  db.collection('live_chats').onSnapshot(snap => {
    snap.docChanges().forEach(ch => {
      const id = ch.doc.id;
      if (!activeChatListeners.has(id)) attachChatMessageListener(id);
      if (ch.type === 'removed') activeChatListeners.delete(id);
    });
  }, err => console.error('[Firestore live_chats]', err));
}

function attachChatMessageListener(chatId) {
  const unsubscribe = db.collection('live_chats').doc(chatId).collection('messages')
    .orderBy('timestamp', 'asc')
    .onSnapshot(snap => {
      const chatPromise = db.collection('live_chats').doc(chatId).get();
      chatPromise.then(chatDoc => {
        const chat = chatDoc.data() || {};
        snap.docChanges().forEach(ch => {
          if (ch.type !== 'added') return;
          const data = ch.doc.data();
          if (bootReady && isRecent(data.timestamp)) notifyLiveMessage(chatId, chat, ch.doc.id, data).catch(console.error);
        });
      }).catch(console.error);
    }, err => console.error(`[Firestore live chat ${chatId}]`, err));
  activeChatListeners.set(chatId, unsubscribe);
}

async function boot() {
  watchContacts();
  watchAppointments();
  watchLiveChats();
  setTimeout(() => { bootReady = true; console.log('[Bridge] Ready. Telegram + Firestore listeners active.'); }, 2500);
}

app.listen(PORT, () => console.log(`[HTTP] http://localhost:${PORT}`));
console.log('[Telegram] Bot polling started.');
boot().catch(err => { console.error(err); process.exit(1); });
