// server/index.js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { Client } from '@stomp/stompjs';
import WebSocket from 'ws';
import { sendText } from '../src/forwarder.js';
import { extractAllPhones } from '../src/utils.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

/* ---------------- ENV ---------------- */
const {
  PORT = 4245,
  DEBUG = '1',
  WEBHOOK_SECRET,

  // Wa-Bridge kanalı
  GROUP_A_JID,
  GROUP_A_JID2,
  TARGET_API_BASE = 'https://mototaksi.az:9898',
  WS_URL = 'wss://mototaksi.az:9898/ws',
  ONE_SIGNAL_APP_ID,
  ONE_SIGNAL_REST_API_KEY,
  ANDROID_CHANNEL_ID,

  // Bigli kanalı
  GROUP_MAP_JSON = '{}',
  ENFORCE_ADMIN = '0',
  RATE_GAP_MS = '6000',

  // (köhnə wa-bridge dəyişəni; event filtrinə təsir edə bilər)
  MULTI_EVENT = '0',
} = process.env;

const ALLOWED_GROUPS = new Set([GROUP_A_JID, GROUP_A_JID2].filter(Boolean));
let GROUP_MAP = {};
try { GROUP_MAP = JSON.parse(GROUP_MAP_JSON || '{}'); } catch { GROUP_MAP = {}; }

const dlog = (...a) => { if (String(DEBUG) === '1') console.log(new Date().toISOString(), ...a); };

/* ---------------- STOMP (Wa-Bridge) ---------------- */
let stompClient = null, stompReady = false;
const publishQueue = [];
function initStomp() {
  if (stompClient) return;
  stompClient = new Client({
    brokerURL: WS_URL,
    webSocketFactory: () => new WebSocket(WS_URL),
    reconnectDelay: 5000,
    heartbeatIncoming: 20000,
    heartbeatOutgoing: 20000,
    onConnect: () => {
      stompReady = true;
      dlog('STOMP connected');
      while (publishQueue.length) {
        const m = publishQueue.shift();
        try { stompClient.publish(m); } catch (e) { console.error('STOMP flush err:', e?.message); }
      }
    },
    onWebSocketClose: () => { stompReady = false; dlog('STOMP closed, will reconnect…'); },
    onStompError: (f) => { stompReady = false; console.error('STOMP error:', f.headers?.message, f.body); },
    debug: (s) => { if (String(DEBUG) === '1') console.log('[STOMP]', s); },
  });
  stompClient.activate();
}
function publishStomp(destination, payloadObj) {
  const body = JSON.stringify(payloadObj);
  if (stompClient && stompReady) {
    try { stompClient.publish({ destination, body }); dlog('STOMP publish ok:', { destination }); }
    catch (e) { console.error('STOMP publish error, queueing:', e?.message); publishQueue.push({ destination, body }); }
  } else { publishQueue.push({ destination, body }); initStomp(); }
}
initStomp();

/* ---------------- Helper-lər (ortaq) ---------------- */
function verifySignature(req) {
  const sig =
    req.get('x-webhook-signature') ||
    req.get('x-wasender-signature') ||
    req.get('x-signature') ||
    req.get('x-was-signature');
  return !!sig && !!WEBHOOK_SECRET && sig === WEBHOOK_SECRET;
}
const dedup = new Map(); const DEDUP_MS = 5 * 60 * 1000;
function seenRecently(id) {
  if (!id) return false;
  const now = Date.now(), ts = dedup.get(id);
  if (ts && now - ts < DEDUP_MS) return true;
  dedup.set(id, now);
  for (const [k, v] of dedup) if (now - v > DEDUP_MS) dedup.delete(k);
  return false;
}
function normalizeEnvelope(data) {
  const env = data?.messages || data?.message || data || {};
  const key = env.key || {};
  const msg = env.message || {};
  return {
    key, msg,
    remoteJid: key.remoteJid || env.remoteJid,
    participant: key.participant || env.participant,
    id: key.id || env.id,
    fromMe: !!(key.fromMe || env.fromMe),
    raw: env,
  };
}
function extractText(msg) {
  return (
    msg?.conversation ||
    msg?.extendedTextMessage?.text ||
    msg?.imageMessage?.caption ||
    msg?.videoMessage?.caption ||
    ''
  );
}
function findFirstSnetJidDeep(any) {
  if (any == null) return null;
  if (typeof any === 'string') return (/^\d+(?::\d+)?@s\.whatsapp\.net$/).test(any) ? any : null;
  if (Array.isArray(any)) { for (const v of any) { const h = findFirstSnetJidDeep(v); if (h) return h; } return null; }
  if (typeof any === 'object') { for (const k of Object.keys(any)) { const h = findFirstSnetJidDeep(any[k]); if (h) return h; } }
  return null;
}
function parsePhoneFromSNetJid(jid) { if (!jid) return null; const m = String(jid).match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/); return m ? m[1] : null; }
function parseDigitsFromLid(jid) { if (!jid) return null; const m = String(jid).match(/^(\d+)@lid$/); return m ? m[1] : String(jid).replace(/@.*/, ''); }
function formatBakuTimestamp(date = new Date()) {
  const t = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Baku', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
  return t.replace('T', ' ').replaceAll('.', ':');
}

/* ---- Wa-Bridge: statik location ---- */
function getStaticLocation(msg) {
  if (!msg) return null;
  const core = msg.viewOnceMessageV2?.message || msg;
  const lm = core?.locationMessage; if (!lm) return null;
  const lat = Number(lm.degreesLatitude), lng = Number(lm.degreesLongitude);
  return { lat, lng, name: lm.name || null, address: lm.address || null, caption: lm.caption || null, _raw: lm };
}

/* ---- Wa-Bridge: push ---- */
function isValidUUID(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || '').trim()); }
async function fetchPushTargets(senderUserId = 0) {
  try {
    const [usersRes, groupRes] = await Promise.all([
      axios.get(`${TARGET_API_BASE}/api/v5/user`, { timeout: 15000 }),
      axios.get(`${TARGET_API_BASE}/api/v5/chat_group/1`, { timeout: 15000 }),
    ]);
    const muted = new Set((groupRes?.data?.mutedUserIds || []).map(Number));
    return (usersRes?.data || [])
      .filter(u => Number(u.id) !== Number(senderUserId) && !(u.userType || '').includes('customer') && !muted.has(Number(u.id)) && !!u.oneSignal)
      .map(u => u.oneSignal);
  } catch { return []; }
}
async function sendPushNotification(ids, title, body) {
  const input = (Array.isArray(ids) ? ids : [ids]).map(x => String(x || '').trim());
  const valid = [...new Set(input.filter(isValidUUID))];
  if (!valid.length) return;
  // yalnız appVersion === 25
  let v25Ids = [];
  try {
    const usersRes = await axios.get(`${TARGET_API_BASE}/api/v5/user`, { timeout: 15000 });
    const v25 = new Set((usersRes?.data || [])
      .filter(u => Number(u?.appVersion) === 25 && u?.oneSignal && isValidUUID(String(u.oneSignal)))
      .map(u => String(u.oneSignal).trim()));
    v25Ids = valid.filter(id => v25.has(id));
  } catch { return; }
  if (!v25Ids.length) return;

  const payload = {
    app_id: ONE_SIGNAL_APP_ID,
    include_subscription_ids: v25Ids,
    headings: { en: title },
    contents: { en: body },
    android_channel_id: ANDROID_CHANNEL_ID,
    data: { screen: 'OrderGroup', groupId: 1 },
  };
  try {
    await axios.post('https://onesignal.com/api/v1/notifications', payload, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${ONE_SIGNAL_REST_API_KEY}` },
      timeout: 15000,
    });
  } catch { }
}

/* ---------------- Bigli tərəfinə aid keşi (reaction üçün) ---------------- */
const MSG_CACHE = new Map();
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
function cacheSet(id, entry) { if (!id) return; MSG_CACHE.set(id, { ...entry, ts: Date.now() }); for (const [k, v] of MSG_CACHE) { if (Date.now() - (v.ts || 0) > CACHE_TTL_MS) MSG_CACHE.delete(k); } }
function cacheGet(id) { const hit = id ? MSG_CACHE.get(id) : null; if (!hit) return null; if (Date.now() - (hit.ts || 0) > CACHE_TTL_MS) { MSG_CACHE.delete(id); return null; } return hit; }
const isThumbsUp = e => (e === '👍' || e === '\uD83D\uDC4D' || e === ':thumbsup:');

/* ---- Wa-Bridge mətn filtr və dublikat yoxlaması ---- */
function shouldBlockMessage(raw) {
  if (!raw) return false;
  const text = String(raw).normalize('NFKC');
  const lower = text.toLowerCase();
  if (/\b(l[əe]ğ?v|stop)\b/i.test(text)) return true;
  if (/\btap(i|ı)ld(i|ı)\b/i.test(text)) return true;
  if (/^\s*\++\s*$/.test(text)) return true;
  if (/\+994[\d\s-]{7,}/.test(lower)) return true;
  return false;
}
async function isDuplicateChatMessage(messageText) {
  try {
    const res = await axios.get(`${TARGET_API_BASE}/api/chats`, { timeout: 15000 });
    const list = Array.isArray(res?.data) ? res.data : [];
    const needle = String(messageText || '').trim();
    if (!needle) return false;
    return list.some(c => String(c?.message || '').trim() === needle);
  } catch { return false; }
}

/* ---------------- ROUTES ---------------- */
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/webhook', async (req, res) => {
  res.status(200).json({ received: true }); // Wasender sürətli 200 istəyir

  try {
    if (!verifySignature(req)) { dlog('Invalid signature'); return; }

    const { event, data } = req.body || {};
    const allowedCommon = ['messages-group.received', 'messages.received', 'messages.upsert', 'messages.reaction'];
    const allowedWa = String(MULTI_EVENT) === '1'
      ? ['messages-group.received', 'messages.received', 'messages.upsert']
      : ['messages-group.received'];
    if (!new Set([...allowedCommon, ...allowedWa]).has(String(event))) { dlog('Skip: event not allowed', event); return; }

    const env = normalizeEnvelope(data);
    const { remoteJid, participant, id: msgId, fromMe, msg } = env;
    if (!remoteJid || fromMe || seenRecently(msgId)) return;

    /* ---------- 1) Wa-Bridge kanalına düşürsə ---------- */
    if (ALLOWED_GROUPS.has(remoteJid)) {
      // location
      const loc = getStaticLocation(msg);
      if (loc) {
        const timestamp = formatBakuTimestamp();
        const normalizedPhone = (parsePhoneFromSNetJid(findFirstSnetJidDeep(req.body)) ||
          parsePhoneFromSNetJid(participant) ||
          parseDigitsFromLid(participant) || '');
        const phonePrefixed = normalizedPhone ? `+${normalizedPhone}`.replace('++', '+') : '';
        const chat = {
          id: Date.now(), groupId: "0", userId: 2, username: "Sifariş Qrupu İstifadəçisi",
          phone: phonePrefixed, isSeenIds: [], messageType: "location", isReply: "false", userType: "customer",
          message: loc.caption || loc.name || "", timestamp, isCompleted: false,
          locationLat: loc.lat, locationLng: loc.lng, thumbnail: loc._raw?.jpegThumbnail || null
        };
        publishStomp('/app/sendChatMessage', chat);
        try {
          const ids = await fetchPushTargets(0);
          const preview = (chat.message && chat.message.trim()) ? chat.message.slice(0, 140) : `${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`;
          if (ids.length) await sendPushNotification(ids, '🪄🪄 Yeni Sifariş!!', `📍 ${preview}`);
        } catch { }
        return;
      }
      // text
      const textBody = extractText(msg);
      if (!textBody) { dlog('WaBridge: no text'); return; }
      if (shouldBlockMessage(textBody)) { dlog('WaBridge: blocked by filter'); return; }
      if (await isDuplicateChatMessage(String(textBody))) { dlog('WaBridge: duplicate text'); return; }

      const chat = {
        id: Date.now(), groupId: "0", userId: 2, username: 'Sifariş Qrupu İstifadəçisi',
        phone: '', isSeenIds: [], messageType: "text", isReply: "false", userType: "customer",
        message: String(textBody), timestamp: formatBakuTimestamp(), isCompleted: false,
      };
      publishStomp('/app/sendChatMessage', chat);
      try {
        const ids = await fetchPushTargets(0);
        if (ids.length) await sendPushNotification(ids, '🪄🪄 Yeni Sifariş!!', `📩 ${String(textBody).slice(0, 140)}`);
      } catch { }
      return;
    }

    /* ---------- 2) BigliKuryerWP kanalına düşürsə ---------- */
    if (GROUP_MAP[remoteJid]) {
      const { admin: adminMsisdn, courier: courierMsisdn } = GROUP_MAP[remoteJid] || {};
      const senderDigits = String(participant || '').replace(/\D/g, '').replace(/@.*/, '');
      const onlyAdmin = String(ENFORCE_ADMIN) === '1';
      if (onlyAdmin && senderDigits !== String(adminMsisdn || '')) { dlog('Bigli: not admin'); return; }

      // reaction → DONE
      const r = msg.reactionMessage || msg.reactionMessageV2 || null;
      if (r) {
        const emoji = r.text || r.emoji || r.reactionEmoji || '';
        const reactedMsgId = r.key?.id || r.messageKey?.id || r.key?.stanzaId || r.messageKey?.stanzaId || null;
        if (['👍', '\uD83D\uDC4D', ':thumbsup:'].includes(emoji) && reactedMsgId) {
          const hit = cacheGet(reactedMsgId);
          if (!hit?.nums?.length) return;
          const courierHuman = courierMsisdn?.startsWith('994') ? ('+' + courierMsisdn) : (courierMsisdn || '');
          const doneBody = `Sifarişiniz tamamlandı ✅\nKuryer ${courierHuman} 📞\n\n*Hər növ Kuryer xidməti üçün* www.biglikuryer.az`;
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          for (const num of hit.nums) {
            let ok = false, tries = 0;
            while (!ok && tries < 3) {
              tries++;
              try { await sendText({ to: '+' + num, text: doneBody }); ok = true; }
              catch (e) { const ra = Number(e?.response?.data?.retry_after || 0); await sleep((ra > 0 ? ra * 1000 + 500 : Number(RATE_GAP_MS))); }
            }
            await sleep(Number(RATE_GAP_MS));
          }
        }
        return;
      }

      // text → extract phones → “kuryer təyin edildi”
      const text = extractText(msg);
      if (!text) { dlog('Bigli: no text'); return; }
      const recipients = extractAllPhones(text);
      if (!recipients.length) { dlog('Bigli: no phone found'); return; }

      cacheSet(msgId, { group: remoteJid, nums: recipients, text });

      const courierHuman = courierMsisdn?.startsWith('994') ? ('+' + courierMsisdn) : (courierMsisdn || '');
      const body = `Sifarişinizə bağlı kuryer təyin edildi 🛵\nKuryer ${courierHuman} 📞\n\n*Hər növ Kuryer xidməti üçün* www.biglikuryer.az`;

      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (const num of recipients) {
        let attempt = 0, sent = false;
        while (!sent && attempt < 3) {
          attempt++;
          try { await sendText({ to: '+' + num, text: body }); sent = true; }
          catch (e) { const ra = Number(e?.response?.data?.retry_after || 0); await sleep((ra > 0 ? ra * 1000 + 500 : Number(RATE_GAP_MS))); }
        }
        await sleep(Number(RATE_GAP_MS));
      }
      return;
    }

    dlog('Skip: remoteJid not matched to any map');

  } catch (e) {
    console.error('Webhook error:', e?.response?.data || e.message);
  }
});

app.listen(PORT, () => {
  console.log(`Unified bridge running on :${PORT}`);
  console.log('ALLOWED_GROUPS (Wa-Bridge):', [...ALLOWED_GROUPS]);
  console.log('GROUP_MAP (Bigli):', Object.keys(GROUP_MAP));
  if (process.env.DRY_RUN) console.log('*** DRY_RUN ON ***');
});

