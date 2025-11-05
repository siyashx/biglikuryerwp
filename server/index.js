import 'dotenv/config';
import express from 'express';
import { sendText } from '../src/forwarder.js';
import { extractAllPhones } from '../src/utils.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// Qruplar xəritəsi (ENV-dən)
let GROUP_MAP = {};
try { GROUP_MAP = JSON.parse(process.env.GROUP_MAP_JSON || '{}'); } catch { GROUP_MAP = {}; }

// sadə dedup (5 dəq)
const processed = new Map();
const WINDOW_MS = 5 * 60 * 1000;
function seenRecently(id) {
  if (!id) return false;
  const now = Date.now();
  const ts = processed.get(id);
  if (ts && now - ts < WINDOW_MS) return true;
  processed.set(id, now);
  for (const [k, v] of processed) if (now - v > WINDOW_MS) processed.delete(k);
  return false;
}

function parseMsisdnFromSnet(jid) {
  if (!jid) return '';
  const m = String(jid).match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);
  return m ? m[1] : '';
}

// JSON içində ilk "...@s.whatsapp.net" dəyərini tap (rekursiv)
function findFirstSnetJidDeep(any) {
  if (any == null) return null;
  if (typeof any === 'string') {
    return /^\d+(?::\d+)?@s\.whatsapp\.net$/.test(any) ? any : null;
  }
  if (Array.isArray(any)) {
    for (const v of any) {
      const hit = findFirstSnetJidDeep(v);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof any === 'object') {
    for (const k of Object.keys(any)) {
      const hit = findFirstSnetJidDeep(any[k]);
      if (hit) return hit;
    }
  }
  return null;
}

function normalizeDigits(s) {
  return String(s || '').replace(/\D/g, '');
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/webhook', async (req, res) => {
  try {
    const sig =
      req.get('x-webhook-signature') ||
      req.get('x-wasender-signature') ||
      req.get('x-signature');

    console.log('↪️  /webhook hit', { hasSig: !!sig, ct: req.get('content-type') });

    if (!sig || sig !== process.env.WEBHOOK_SECRET) {
      console.warn('⛔  Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    // WaSender sürətli cavab istəyir
    res.status(200).json({ received: true });

    const { event, data } = req.body || {};
    const allowed = new Set(['messages-group.received', 'messages.received', 'messages.upsert']);
    if (!allowed.has(String(event))) {
      console.log('ℹ️  Skip (event not allowed):', event);
      return;
    }

    // Bəzi payloadlarda mesaj "messages"/"message" altından gəlir
    // Bəzi payloadlar massiv gətirə bilər: data.messages = [ { key, message, ... } ]
    let envRaw = (req.body?.data || {});
    let env = envRaw;

    // Prioritet: messages[0] -> message -> data (flatten)
    if (Array.isArray(envRaw.messages) && envRaw.messages.length > 0) {
      env = envRaw.messages[0];
    } else if (envRaw.message) {
      env = envRaw.message;
    }

    // key və message obyektlərini götür
    const key = env.key || {};
    const msg = env.message || {};

    // remoteJid və fromMe
    const remoteJid = key.remoteJid || env.remoteJid || envRaw.remoteJid;
    const fromMe = !!(key.fromMe || env.fromMe || envRaw.fromMe);

    // Qrup tanınmırsa və ya özümüzdəndirsə çıx
    if (!remoteJid || !GROUP_MAP[remoteJid]) return;
    if (fromMe) return;

    const { admin: adminMsisdn, courier: courierMsisdn } = GROUP_MAP[remoteJid] || {};

    // 1-ci cəhd: key.participant
    let senderMsisdn = parseMsisdnFromSnet(key.participant || env.participant);

    // 2-ci cəhd: bütün body içindən ilk s.whatsapp.net JID tap
    if (!senderMsisdn) {
      const deep = findFirstSnetJidDeep(req.body);
      senderMsisdn = parseMsisdnFromSnet(deep);
    }

    // 3-cü cəhd: contextInfo.participant kimi bəzi künc hallar
    if (!senderMsisdn) {
      const ci = msg?.extendedTextMessage?.contextInfo || msg?.messageContextInfo;
      senderMsisdn = parseMsisdnFromSnet(ci?.participant);
    }

    // Normalizə
    const senderDigits = normalizeDigits(senderMsisdn);
    const courierDigits = normalizeDigits(courierMsisdn);

    // 🔒 YALNIZ bu qayda: mesaj KURYERdəndirsə, heç nə etmə
    if (courierDigits && senderDigits.endsWith(courierDigits)) {
      console.log('ℹ️  Skip (message written by courier)', { senderDigits, courierDigits });
      return;
    }

    // admin məhdudiyyəti ENV ilə
    const ENFORCE_ADMIN = (process.env.ENFORCE_ADMIN || '0') === '1';
    if (ENFORCE_ADMIN && senderMsisdn !== String(adminMsisdn || '')) {
      console.log('ℹ️  Skip (not admin)', { senderMsisdn, expected: adminMsisdn });
      return;
    }

    if (seenRecently(msgId)) {
      console.log('ℹ️  Skip (dup id)', msgId);
      return;
    }

    const text =
      msg.conversation ||
      msg.extendedTextMessage?.text ||
      msg.imageMessage?.caption ||
      msg.videoMessage?.caption ||
      '';

    if (!text) {
      console.log('ℹ️  Skip (no text)');
      return;
    }

    console.log('📝 text preview:', text.slice(0, 200));

    // BÜTÜN nömrələri çıxar
    const recipients = extractAllPhones(text);
    if (!recipients.length) {
      console.log('⚠️  Nömrə tapılmadı');
      return;
    }

    const courierHuman = (courierMsisdn && courierMsisdn.startsWith('994'))
      ? '+' + courierMsisdn
      : (courierMsisdn || '');

    const body = `Sifarişiniz ${courierHuman} tərəfindən qəbul edildi.`;

    console.log('📤 Göndəriləcək nömrələr:', recipients);

    const GAP_MS_DEFAULT = Number(process.env.RATE_GAP_MS || 5500); // 5.5s default
    const results = [];

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    for (const num of recipients) {
      let attempt = 0;
      let sent = false;
      while (!sent && attempt < 3) {
        attempt++;
        try {
          const r = await sendText({ to: '+' + num, text: body });
          console.log('✅ OK =>', num, r);
          results.push({ to: num, ok: true, r });
          sent = true;
        } catch (e) {
          const payload = e?.response?.data || e?.message || e;
          const retryAfterSec = Number(payload?.retry_after || 0);
          console.error(`❌ FAIL (try ${attempt}) =>`, num, payload);

          if (retryAfterSec > 0) {
            // Wasender konkret “retry_after” veribsə ona görə gözlə
            await sleep((retryAfterSec * 1000) + 500);
          } else {
            // başqa səhvdirsə, qısa fasilə verib yenidən cəhd et
            await sleep(GAP_MS_DEFAULT);
          }
          if (attempt >= 3) {
            results.push({ to: num, ok: false, err: payload });
          }
        }
      }

      // növbəti nömrəyə keçməzdən əvvəl sürət limiti üçün aralıq
      await sleep(GAP_MS_DEFAULT);
    }

    const ok = results.filter(x => x.ok).length;
    const fail = results.length - ok;
    console.log(`📊 Nəticə — ✅ ${ok} | ❌ ${fail} | cəmi ${results.length}`);

  } catch (e) {
    console.error('Webhook handler error:', e?.response?.data || e.message);
  }
});

const PORT = process.env.PORT || 4245;
app.listen(PORT, () => {
  const mask = s => (s ? s.slice(0, 6) + '***' : '[absent]');
  console.log(`Bridge running on :${PORT}`);
  console.log('GROUP_MAP groups:', Object.keys(GROUP_MAP).length);
  console.log('WASENDER_API_KEY   =>', mask(process.env.WASENDER_API_KEY));
});

