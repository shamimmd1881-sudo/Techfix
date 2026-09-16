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

async function sendAdmin(text, opts = {}) {
  if (!ADMIN_CHAT_ID) {
    console.warn('[Telegram] ADMIN_TELEGRAM_CHAT_ID is not configured. Notification skipped.');
    return null;
  }
  return bot.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: 'HTML', ...opts });
}

// --- Exactly-once notification guard ---
// If a redeploy briefly overlaps with the previous instance (common on
// container hosts), BOTH processes see the same new Firestore doc and would
// each send a Telegram notification, causing duplicates. This claims a
// unique marker doc atomically (Firestore .create() fails if it already
// exists) so only the process that wins the race actually sends.
const NOTIFIED_COLLECTION = 'tg_notified';
async function claimNotification(kind, id) {
  try {
    await db.collection(NOTIFIED_COLLECTION).doc(`${kind}_${id}`).create({ at: FieldValue.serverTimestamp() });
    return true;
  } catch (e) {
    if (e && (e.code === 6 || e.code === 'already-exists')) return false; // already claimed
    console.error('[claimNotification] unexpected error, sending anyway:', e.message);
    return true; // fail open rather than silently dropping a real notification
  }
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
    console.error('[tg_reply_map] Failed to persist reply target:', e.message);
  }
}

async function getReplyTarget(telegramMessageId) {
  if (replyMap.has(telegramMessageId)) return replyMap.get(telegramMessageId);
  try {
    const doc = await db.collection(REPLY_MAP_COLLECTION).doc(String(telegramMessageId)).get();
    if (doc.exists) {
      const target = doc.data();
      replyMap.set(telegramMessageId, target);
      return target;
    }
  } catch (e) {
    console.error('[tg_reply_map] Failed to look up reply target:', e.message);
  }
  return null;
}

// --- "Active chat" state: which live chat the admin's next plain messages
// go to, selected from the /chats list instead of needing Reply gestures.
// Persisted to Firestore so it survives restarts. ---
let activeChatTargetId = null;
const BOT_STATE_DOC = db.collection('bot_state').doc('admin');

async function setActiveChatTarget(id) {
  activeChatTargetId = id || null;
  try {
    await BOT_STATE_DOC.set({ activeChatId: id || FieldValue.delete() }, { merge: true });
  } catch (e) {
    console.error('[bot_state] Failed to persist active chat target:', e.message);
  }
}

async function loadActiveChatTarget() {
  try {
    const doc = await BOT_STATE_DOC.get();
    if (doc.exists) activeChatTargetId = doc.data().activeChatId || null;
  } catch (e) {
    console.error('[bot_state] Failed to load active chat target:', e.message);
  }
}

// Rename flow: transient, in-memory only (single quick step).
let pendingAction = null; // { type: 'rename', chatId }

function getChatDisplayName(_id, data) {
  return (data && (data.adminAlias || data.name)) || 'Guest';
}

async function notifyContact(id, data) {
  if (!(await claimNotification('contact', id))) return;
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
  if (!(await claimNotification('appt', id))) return;
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

// Kept minimal per requirements: only visitor, email, and message. No chat id,
// no instructions. (Reply-to-message still works internally via the map above;
// the primary way to reply is now the /chats list.)
async function notifyLiveMessage(chatId, chat, messageId, data) {
  if (data.sender !== 'customer') return;
  if (!(await claimNotification('livemsg', messageId))) return;
  const displayName = getChatDisplayName(chatId, chat);
  const msg = await sendAdmin(
    `💬 <b>New Live Chat Message</b>\n\n` +
    `<b>Visitor:</b> ${esc(displayName)}\n` +
    `<b>Email:</b> ${esc(chat.email || '—')}\n\n` +
    `<b>Message:</b>\n${esc(cleanText(data.message))}`
  );
  if (msg) await rememberReplyTarget(msg.message_id, { type: 'livechat', id: chatId });
  // Mark this chat as having an unseen customer message, shown as 🔴 in /chats.
  await db.collection('live_chats').doc(chatId).set({ unread: true }, { merge: true }).catch(console.error);
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
    throw new Error(`No live chat found with id "${chatId}". It may have been deleted.`);
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
    adminOnline: true,
    unread: false
  }, { merge: true });
}

// Last N messages of a chat, oldest first, formatted for a Telegram message.
async function fetchChatHistoryText(liveChatId, limit = 25) {
  const snap = await db.collection('live_chats').doc(liveChatId)
    .collection('messages').orderBy('timestamp', 'desc').limit(limit).get();
  if (snap.empty) return 'এখনো কোনো মেসেজ নেই।';
  const docs = snap.docs.slice().reverse(); // chronological order
  const lines = docs.map(d => {
    const m = d.data();
    const who = m.sender === 'admin' ? '🛠 Admin' : (m.sender === 'bot' ? '🤖 Bot' : '🧑 Customer');
    return `${who} (${fmtTime(m.timestamp)}):\n${cleanText(m.message, 500)}`;
  });
  let text = lines.join('\n\n');
  const MAX = 3500;
  if (text.length > MAX) text = '…(পুরোনো অংশ বাদ দেওয়া হলো)…\n\n' + text.slice(text.length - MAX);
  return text;
}

async function updateAppointment(id, status) {
  const allowed = ['New', 'Contacted', 'Completed', 'Cancelled'];
  if (!allowed.includes(status)) throw new Error(`Invalid status. Use: ${allowed.join(', ')}`);
  await db.collection('appointments').doc(id).update({ status, statusUpdatedAt: FieldValue.serverTimestamp() });
}

// ---------------------------------------------------------------------------
// Chat list management (list, pin, rename, delete, message-select)
// ---------------------------------------------------------------------------

async function listChatsForAdmin(limit = 30) {
  const snap = await db.collection('live_chats').orderBy('lastUpdated', 'desc').limit(limit).get();
  const chats = snap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      pinned: !!data.pinned,
      unread: !!data.unread,
      displayName: getChatDisplayName(d.id, data),
      email: data.email || '—',
      lastMessage: data.lastMessage || '',
      lastUpdated: data.lastUpdated
    };
  });
  chats.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  return chats;
}

async function renderChatList(chatId, messageId) {
  const chats = await listChatsForAdmin();
  if (chats.length === 0) {
    const text = '📭 এখনো কোনো লাইভ চ্যাট নেই।';
    if (messageId) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId }).catch(() => bot.sendMessage(chatId, text));
    } else {
      await bot.sendMessage(chatId, text);
    }
    return;
  }
  const keyboard = chats.map(c => ([{
    text: `${c.unread ? '🔴 ' : ''}${c.pinned ? '📌 ' : ''}${c.displayName}${c.lastMessage ? ' — ' + c.lastMessage.slice(0, 25) : ''}`,
    callback_data: `cl:o:${c.id}`
  }]));
  const text = `💬 <b>লাইভ চ্যাট লিস্ট</b> (${chats.length}টি)\n🔴 = নতুন অপঠিত মেসেজ\n\nএকজনকে সিলেক্ট করুন বিস্তারিত দেখতে ও অ্যাকশন নিতে:`;
  const reply_markup = { inline_keyboard: keyboard };
  if (messageId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup })
      .catch(() => bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup }));
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
  }
}

async function renderChatDetail(chatId, messageId, liveChatId) {
  const snap = await db.collection('live_chats').doc(liveChatId).get();
  if (!snap.exists) {
    const reply_markup = { inline_keyboard: [[{ text: '⬅️ লিস্টে ফিরুন', callback_data: 'cl:list' }]] };
    await bot.editMessageText('⚠️ এই চ্যাটটি আর নেই (ডিলিট হয়ে গেছে)।', { chat_id: chatId, message_id: messageId, reply_markup }).catch(() => {});
    return;
  }
  const data = snap.data();
  const name = getChatDisplayName(liveChatId, data);
  const text =
    `👤 <b>${esc(name)}</b>\n` +
    `Email: ${esc(data.email || '—')}\n` +
    (data.pinned ? `📌 পিন করা আছে\n` : '') +
    `\nসর্বশেষ মেসেজ:\n${esc(cleanText(data.lastMessage || '—', 300))}\n\n` +
    `সর্বশেষ আপডেট: ${fmtTime(data.lastUpdated)}`;
  const keyboard = [
    [{ text: '💬 মেসেজ পাঠান', callback_data: `cl:m:${liveChatId}` }],
    [{ text: data.pinned ? '📌 আনপিন করুন' : '📌 পিন করুন', callback_data: data.pinned ? `cl:u:${liveChatId}` : `cl:p:${liveChatId}` }],
    [{ text: '✏️ রিনেইম করুন', callback_data: `cl:r:${liveChatId}` }],
    [{ text: '🗑 চ্যাট ডিলিট করুন', callback_data: `cl:d:${liveChatId}` }],
    [{ text: '⬅️ লিস্টে ফিরুন', callback_data: 'cl:list' }]
  ];
  const reply_markup = { inline_keyboard: keyboard };
  await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup })
    .catch(() => bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup }));
}

async function deleteCollectionInBatches(collectionRef, batchSize = 300) {
  for (;;) {
    const snap = await collectionRef.limit(batchSize).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < batchSize) break;
  }
}

async function deleteChat(liveChatId) {
  const ref = db.collection('live_chats').doc(liveChatId);
  const unsub = activeChatListeners.get(liveChatId);
  if (unsub) { try { unsub(); } catch (_) {} activeChatListeners.delete(liveChatId); }
  await deleteCollectionInBatches(ref.collection('messages'));
  await ref.delete();
  if (activeChatTargetId === liveChatId) await setActiveChatTarget(null);
}

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  if (!isAdmin({ chat: { id: chatId } })) { await bot.answerCallbackQuery(query.id).catch(() => {}); return; }
  const data = query.data || '';
  try {
    if (data === 'cl:list') {
      await renderChatList(chatId, messageId);
    } else if (data.startsWith('cl:o:')) {
      await renderChatDetail(chatId, messageId, data.slice(5));
    } else if (data.startsWith('cl:p:')) {
      const id = data.slice(5);
      await db.collection('live_chats').doc(id).set({ pinned: true }, { merge: true });
      await renderChatDetail(chatId, messageId, id);
    } else if (data.startsWith('cl:u:')) {
      const id = data.slice(5);
      await db.collection('live_chats').doc(id).set({ pinned: false }, { merge: true });
      await renderChatDetail(chatId, messageId, id);
    } else if (data.startsWith('cl:r:')) {
      const id = data.slice(5);
      pendingAction = { type: 'rename', chatId: id };
      await bot.sendMessage(chatId, '✏️ এই ভিজিটরের জন্য নতুন নাম লিখে পাঠান:');
    } else if (data.startsWith('cl:m:')) {
      const id = data.slice(5);
      await setActiveChatTarget(id);
      const snap = await db.collection('live_chats').doc(id).get();
      const chatData = snap.exists ? snap.data() : {};
      const name = getChatDisplayName(id, chatData);
      const history = await fetchChatHistoryText(id);
      await db.collection('live_chats').doc(id).set({ unread: false }, { merge: true }).catch(() => {});
      await bot.sendMessage(chatId, `🗒 <b>${esc(name)}</b>-এর আগের কথোপকথন:\n\n${esc(history)}`, { parse_mode: 'HTML' });
      await bot.sendMessage(chatId,
        `✍️ এখন থেকে আপনার পরবর্তী মেসেজগুলো (রিপ্লাই মোড ছাড়াই সাধারণভাবে টাইপ করলেই) <b>${esc(name)}</b>-কে পাঠানো হবে এবং সে সাথে সাথে দেখতে পাবে।\nথামাতে বা অন্য কাউকে বেছে নিতে /stopchat বা /chats লিখুন।`,
        { parse_mode: 'HTML' }
      );
    } else if (data.startsWith('cl:d:')) {
      const id = data.slice(5);
      await bot.editMessageText('⚠️ আপনি কি নিশ্চিত এই চ্যাট ডিলিট করতে চান? এটি ফেরানো যাবে না।', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[
          { text: '✅ হ্যাঁ, ডিলিট করুন', callback_data: `cl:dy:${id}` },
          { text: '❌ না', callback_data: `cl:o:${id}` }
        ]] }
      });
    } else if (data.startsWith('cl:dy:')) {
      const id = data.slice(6);
      await deleteChat(id);
      await bot.editMessageText('🗑 চ্যাট ডিলিট করা হয়েছে।', {
        chat_id: chatId, message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: '⬅️ লিস্টে ফিরুন', callback_data: 'cl:list' }]] }
      });
    }
    await bot.answerCallbackQuery(query.id).catch(() => {});
  } catch (e) {
    console.error('[callback_query]', e);
    await bot.answerCallbackQuery(query.id, { text: 'Error: ' + e.message, show_alert: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

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
    `• /chats — সব লাইভ চ্যাট ভিজিটরের লিস্ট দেখুন (🔴 = নতুন অপঠিত মেসেজ), পিন/রিনেইম/ডিলিট করুন, বা মেসেজ পাঠানোর জন্য একজনকে বেছে নিন (সিলেক্ট করলে আগের সব মেসেজ দেখাবে)\n` +
    `• /stopchat — /chats থেকে বেছে নেওয়া "মেসেজিং মোড" বন্ধ করুন\n` +
    `• /broadcast [মেসেজ] — সব লাইভ চ্যাট ভিজিটরকে একসাথে একটা মেসেজ পাঠান\n` +
    `• (ঐচ্ছিক) কোনো লাইভ চ্যাট নোটিফিকেশনে সরাসরি Reply করেও তাকে উত্তর দেওয়া যাবে\n` +
    `• Reply to a contact notification → send email reply\n` +
    `• Reply to an appointment notification with <code>/status Contacted</code>\n` +
    `• /status New|Contacted|Completed|Cancelled (as a reply to an appointment)`,
    { parse_mode: 'HTML' }
  );
});

bot.onText(/^\/chats(?:@\w+)?$/i, async (msg) => {
  if (!isAdmin(msg)) return;
  await renderChatList(msg.chat.id, null);
});

bot.onText(/^\/stopchat(?:@\w+)?$/i, async (msg) => {
  if (!isAdmin(msg)) return;
  await setActiveChatTarget(null);
  await bot.sendMessage(msg.chat.id, '🛑 মেসেজিং মোড বন্ধ করা হয়েছে।');
});

bot.onText(/^\/broadcast(?:@\w+)?\s+([\s\S]+)$/i, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const text = cleanText(match[1], 1500);
  try {
    const snap = await db.collection('live_chats').get();
    let sent = 0, failed = 0;
    for (const doc of snap.docs) {
      try {
        await replyToLiveChat(doc.id, text);
        sent++;
      } catch (e) {
        failed++;
      }
    }
    await bot.sendMessage(
      msg.chat.id,
      `📣 Broadcast পাঠানো হয়েছে <b>${sent}</b> জন ভিজিটরকে${failed ? ` (${failed} জনকে পাঠানো যায়নি)` : ''}।`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ ${esc(e.message)}`);
  }
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

bot.on('message', async (msg) => {
  if (!isAdmin(msg) || !msg.text || msg.text.startsWith('/')) return;
  const text = cleanText(msg.text, 2000);

  // 1) Rename flow in progress
  if (pendingAction && pendingAction.type === 'rename') {
    const liveChatId = pendingAction.chatId;
    pendingAction = null;
    try {
      await db.collection('live_chats').doc(liveChatId).set({ adminAlias: text }, { merge: true });
      await bot.sendMessage(msg.chat.id, `✅ নাম পরিবর্তন করা হয়েছে: <b>${esc(text)}</b>`, { parse_mode: 'HTML' });
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ ${esc(e.message)}`);
    }
    return;
  }

  // 2) Reply-to-notification flow, but if the swiped notification isn't
  //    mapped anymore, fall through to the active chat (step 3) instead of
  //    forcing the admin to use Reply mode at all — plain typing while a
  //    chat is selected should always work, swipe or no swipe.
  const replied = msg.reply_to_message;
  if (replied) {
    const target = await getReplyTarget(replied.message_id);
    if (target) {
      try {
        if (target.type === 'livechat') {
          await replyToLiveChat(target.id, text);
          await bot.sendMessage(msg.chat.id, '✅ Reply sent to the website visitor.');
        } else if (target.type === 'contact') {
          await replyToContact(target, text);
          await bot.sendMessage(msg.chat.id, `✅ Email reply sent to ${esc(target.email)}.`, { parse_mode: 'HTML' });
        } else if (target.type === 'appointment') {
          await bot.sendMessage(msg.chat.id, 'ℹ️ Use /status Contacted (etc.) as a reply to change an appointment status.', { parse_mode: 'HTML' });
        }
      } catch (e) {
        console.error('[reply handler]', e);
        await bot.sendMessage(msg.chat.id, `❌ ${esc(e.message)}`);
      }
      return;
    }
    // target not found — don't return here, fall through to step 3
  }

  // 3) A visitor was selected from /chats — plain messages (no Reply needed)
  //    go straight to them, and this also catches an unmapped swipe-reply
  //    from step 2 above.
  if (activeChatTargetId) {
    try {
      await replyToLiveChat(activeChatTargetId, text);
      await bot.sendMessage(msg.chat.id, '✅ পাঠানো হয়েছে।');
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ ${esc(e.message)}`);
    }
    return;
  }

  // 4) Nothing matched
  if (replied) {
    await bot.sendMessage(msg.chat.id, '⚠️ This notification is no longer mapped. Use /chats to pick a visitor from the list instead.');
    return;
  }
  await bot.sendMessage(
    msg.chat.id,
    '⚠️ বুঝতে পারিনি। /chats লিখে ভিজিটরদের লিস্ট থেকে একজনকে বেছে মেসেজ পাঠান, অথবা কোনো নোটিফিকেশনে সরাসরি Reply করুন।'
  );
});

// ---------------------------------------------------------------------------
// Realtime Firestore watchers
// ---------------------------------------------------------------------------

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
      db.collection('live_chats').doc(chatId).get().then(chatDoc => {
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

// ---------------------------------------------------------------------------
// Maintenance jobs
//   1) Auto-cancel appointments nobody acted on, 5 days after their slot ends
//   2) Delete data older than 30 days to keep Firestore storage costs down
// ---------------------------------------------------------------------------

const APPOINTMENT_GRACE_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;         // 30 days

// appointmentDate looks like "2026-09-20", appointmentTime like "09:00-11:00".
// Interpreted as Asia/Dhaka (UTC+6) local time, since that's where the business is.
function parseAppointmentEnd(dateStr, timeStr) {
  if (!dateStr) return null;
  const endPart = String(timeStr || '').split('-')[1] || String(timeStr || '').split('-')[0] || '23:59';
  const [h, m] = endPart.split(':').map(n => Number(n) || 0);
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const d = new Date(`${dateStr}T${hh}:${mm}:00+06:00`);
  return isNaN(d.getTime()) ? null : d;
}

async function autoCancelStaleAppointments() {
  try {
    const snap = await db.collection('appointments').get();
    const now = Date.now();
    for (const doc of snap.docs) {
      const data = doc.data();
      const status = data.status || 'New';
      if (status !== 'New') continue;
      const end = parseAppointmentEnd(data.appointmentDate, data.appointmentTime);
      if (!end) continue;
      if (now - end.getTime() >= APPOINTMENT_GRACE_MS) {
        await doc.ref.update({ status: 'Cancelled', autoCancelled: true, statusUpdatedAt: FieldValue.serverTimestamp() });
        sendAdmin(`⏰ <b>Auto-cancelled</b> (no action taken within 5 days of the slot): ${esc(data.referenceNumber || doc.id)} — ${esc(data.name || '—')}`).catch(console.error);
      }
    }
  } catch (e) {
    console.error('[autoCancelStaleAppointments]', e);
  }
}

async function deleteOldDocsIn(collectionRef, cutoffTimestamp, field = 'timestamp') {
  const snap = await collectionRef.where(field, '<', cutoffTimestamp).limit(400).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  return snap.size;
}

async function cleanupOldData() {
  try {
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - RETENTION_MS);

    // Old contact messages
    await deleteOldDocsIn(db.collection('contacts'), cutoff);

    // Old dedupe markers for notifications (safe to drop, they're one-time use)
    await deleteOldDocsIn(db.collection(NOTIFIED_COLLECTION), cutoff, 'at');
    await deleteOldDocsIn(db.collection(REPLY_MAP_COLLECTION), cutoff, 'createdAt');

    // Old, resolved appointments (keep unresolved ones regardless of age)
    const apptSnap = await db.collection('appointments').where('timestamp', '<', cutoff).get();
    for (const doc of apptSnap.docs) {
      const st = doc.data().status;
      if (st === 'Completed' || st === 'Cancelled') await doc.ref.delete().catch(console.error);
    }

    // Old live-chat messages (and empty, stale, unpinned chats)
    const chatsSnap = await db.collection('live_chats').get();
    for (const chatDoc of chatsSnap.docs) {
      await deleteOldDocsIn(chatDoc.ref.collection('messages'), cutoff);
      const chatData = chatDoc.data();
      const lastUpdated = chatData.lastUpdated;
      const isStale = lastUpdated && lastUpdated.toMillis && lastUpdated.toMillis() < cutoff.toMillis();
      if (isStale && !chatData.pinned) {
        const remaining = await chatDoc.ref.collection('messages').limit(1).get();
        if (remaining.empty) await chatDoc.ref.delete().catch(console.error);
      }
    }
    console.log('[cleanup] Old data cleanup pass complete.');
  } catch (e) {
    console.error('[cleanupOldData]', e);
  }
}

async function boot() {
  await loadActiveChatTarget();
  watchContacts();
  watchAppointments();
  watchLiveChats();
  setTimeout(() => { bootReady = true; console.log('[Bridge] Ready. Telegram + Firestore listeners active.'); }, 2500);

  // Run maintenance shortly after boot, then every 6 hours.
  setTimeout(() => { autoCancelStaleAppointments(); cleanupOldData(); }, 60 * 1000);
  setInterval(() => { autoCancelStaleAppointments(); cleanupOldData(); }, 6 * 60 * 60 * 1000);
}

app.listen(PORT, () => console.log(`[HTTP] http://localhost:${PORT}`));
console.log('[Telegram] Bot polling started.');
boot().catch(err => { console.error(err); process.exit(1); });
