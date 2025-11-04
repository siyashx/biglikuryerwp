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

    const remoteJid   = key.remoteJid || env.remoteJid;
    const participant = key.participant || env.participant; // "994...[:device]@s.whatsapp.net"
    const msgId       = key.id || env.id;
    const fromMe      = !!(key.fromMe || env.fromMe);

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
    const senderMsisdn = m ? m[1] : '';

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

    // Wasender +994… formatını sevir
    const tasks = recipients.map(num => sendText({ to: '+' + num, text: body }));
    const results = await Promise.allSettled(tasks);

    let ok = 0, fail = 0;
    results.forEach((r, i) => {
      const to = recipients[i];
      if (r.status === 'fulfilled') {
        ok++;
        console.log('✅ OK =>', to, r.value);
      } else {
        fail++;
        console.error('❌ FAIL =>', to, r.reason?.response?.data || r.reason?.message || r.reason);
      }
    });

    console.log(`📊 Nəticə — ✅ ${ok} | ❌ ${fail} | cəmi ${results.length}`, { group: remoteJid });
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
