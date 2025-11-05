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
    const env = data?.messages || data?.message || data || {};
    const key = env.key || {};
    const msg = env.message || {};

    const remoteJid = key.remoteJid || env.remoteJid;
    const participant = key.participant || env.participant; // "994...[:device]@s.whatsapp.net"
    const msgId = key.id || env.id;
    const fromMe = !!(key.fromMe || env.fromMe);

    if (!remoteJid || !GROUP_MAP[remoteJid]) {
      console.log('ℹ️  Skip (unknown group):', { got: remoteJid, known: Object.keys(GROUP_MAP) });
      return;
    }
    if (fromMe) {
      console.log('ℹ️  Skip (fromMe)');
      return;
    }

    const { admin: adminMsisdn, courier: courierMsisdn } = GROUP_MAP[remoteJid] || {};

    // göndərənin MSISDN-ni :device suffix-siz çıxar
    const m = String(participant || '').match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);
    const senderMsisdn = m ? m[1] : '';   // məsələn: "994556165535"

    // 🔒 YALNIZ bu qayda: mesaj kuryerdəndirsə, hec nə etmə
    if (senderMsisdn === String(courierMsisdn || '')) {
      console.log('ℹ️  Skip (message written by courier)', { senderMsisdn, courierMsisdn });
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

