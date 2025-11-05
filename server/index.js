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

// --- Keş: son mesajların nömrələrini saxla (id -> { nums, text, group, ts })
const MSG_CACHE = new Map();
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 saat

function cacheSet(id, entry) {
  if (!id) return;
  MSG_CACHE.set(id, { ...entry, ts: Date.now() });
  // sadə təmizləmə
  const now = Date.now();
  for (const [k, v] of MSG_CACHE) {
    if (now - (v.ts || 0) > CACHE_TTL_MS) MSG_CACHE.delete(k);
  }
}

function cacheGet(id) {
  const hit = id ? MSG_CACHE.get(id) : null;
  if (!hit) return null;
  if (Date.now() - (hit.ts || 0) > CACHE_TTL_MS) {
    MSG_CACHE.delete(id);
    return null;
  }
  return hit;
}

function parseMsisdnFromSnet(jid) {
  if (!jid) return '';
  const m = String(jid).match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);
  return m ? m[1] : '';
}
function normalizeDigits(s) { return String(s || '').replace(/\D/g, ''); }

function isThumbsUp(emoji) {
  return emoji === '👍' || emoji === '\uD83D\uDC4D' || emoji === ':thumbsup:';
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
    const allowed = new Set([
      'messages-group.received',
      'messages.received',
      'messages.upsert',
      'messages.reaction'         // <-- əlavə etdik
    ]);

    if (!allowed.has(String(event))) {
      console.log('ℹ️  Skip (event not allowed):', event);
      return;
    }

    const env = data?.messages || data?.message || data || {};
    const key = env.key || {};
    const msg = env.message || {};

    const remoteJid = key.remoteJid || env.remoteJid;
    const participant = key.participant || env.participant; // "994...[:device]@s.whatsapp.net"
    const msgId = key.id || env.id;
    const fromMe = !!(key.fromMe || env.fromMe);

    if (!remoteJid || !GROUP_MAP[remoteJid]) return;
    if (fromMe) return;

    const { admin: adminMsisdn, courier: courierMsisdn } = GROUP_MAP[remoteJid] || {};
    const senderMsisdn = parseMsisdnFromSnet(participant);
    const senderDigits = normalizeDigits(senderMsisdn);
    const courierDigits = normalizeDigits(courierMsisdn);

    if (seenRecently(msgId)) return;

    // ---- REACTION HANDLER (ENFORCE_ADMIN tətbiq ETMƏ) ----
    const r = msg.reactionMessage || msg.reactionMessageV2 || null;
    if (r) {
      const emoji =
        r.text ||
        r.emoji ||
        r.reactionEmoji ||
        '';

      // Reaksiya event-lərində participant çox vaxt reaction.key.participant içində olur
      const reactionParticipant =
        r.key?.participant ||
        r.messageKey?.participant ||
        r.participant ||
        participant; // son çarə: top-level

      const senderMsisdnForReaction = parseMsisdnFromSnet(reactionParticipant);
      const senderDigitsForReaction = normalizeDigits(senderMsisdnForReaction);

      const reactedMsgId =
        r.key?.id ||
        r.messageKey?.id ||
        r.key?.stanzaId ||
        r.messageKey?.stanzaId ||
        r.messageContextInfo?.stanzaId ||
        null;

      console.log('🟡 reaction seen', {
        emoji, reactedMsgId, senderDigits: senderDigitsForReaction, courierDigits
      });

      if (isThumbsUp(emoji) && reactedMsgId) {
        const hit = cacheGet(reactedMsgId);
        if (!hit || !Array.isArray(hit.nums) || !hit.nums.length) {
          console.log('ℹ️  Reaction but no cached numbers for id:', reactedMsgId);
          return;
        }

        const courierHuman = courierMsisdn?.startsWith('994') ? ('+' + courierMsisdn) : (courierMsisdn || '');
        const doneBody =
          `Sifarişiniz tamamlandı ✅\n` +
          `Kuryer ${courierHuman} 📞\n\n` +
          `*Hər növ Kuryer xidməti üçün* www.biglikuryer.az`;

        console.log('✅ Courier 👍 on', reactedMsgId, '=> will notify:', hit.nums);

        const GAP_MS_DEFAULT = Number(process.env.RATE_GAP_MS || 5500);
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

        for (const num of hit.nums) {
          let ok = false, tries = 0;
          while (!ok && tries < 3) {
            tries++;
            try {
              const rr = await sendText({ to: '+' + num, text: doneBody });
              console.log('✅ DONE OK =>', num, rr);
              ok = true;
            } catch (e) {
              const p = e?.response?.data || e?.message || e;
              const ra = Number(p?.retry_after || 0);
              console.error(`❌ DONE FAIL (try ${tries}) =>`, num, p);
              await sleep((ra > 0 ? ra * 1000 + 500 : GAP_MS_DEFAULT));
            }
          }
          await sleep(GAP_MS_DEFAULT);
        }
      }
      return; // reaksiya emal olundu, mətnə düşmə
    }

    // ENFORCE_ADMIN: yalnız mətn üçün tətbiq et
    const ENFORCE_ADMIN = (process.env.ENFORCE_ADMIN || '0') === '1';
    if (ENFORCE_ADMIN && senderDigits !== normalizeDigits(adminMsisdn)) {
      console.log('ℹ️  Skip (not admin text)', { senderDigits, expected: adminMsisdn });
      return;
    }

    const text =
      msg.conversation ||
      msg.extendedTextMessage?.text ||
      msg.imageMessage?.caption ||
      msg.videoMessage?.caption ||
      '';

    if (!text) { console.log('ℹ️  Skip (no text)'); return; }

    const recipients = extractAllPhones(text);
    if (!recipients.length) { console.log('⚠️  Nömrə tapılmadı'); return; }

    // SİFARİŞ MESAJINI KEŞLƏ
    cacheSet(msgId, { group: remoteJid, nums: recipients, text });
    console.log('🟩 cached', { msgId, count: recipients.length });

    const courierHuman = courierMsisdn?.startsWith('994') ? ('+' + courierMsisdn) : (courierMsisdn || '');
    const body =
      `Sifarişinizə bağlı kuryer təyin edildi 🛵\n` +
      `Kuryer ${courierHuman} 📞\n\n` +
      `*Hər növ Kuryer xidməti üçün* www.biglikuryer.az`;

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

