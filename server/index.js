// index.js
import 'dotenv/config';
import express from 'express';
import { sendText } from '../src/forwarder.js';
import { extractAllPhones } from '../src/utils.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

let GROUP_MAP = {};
try { GROUP_MAP = JSON.parse(process.env.GROUP_MAP_JSON || '{}'); } catch { GROUP_MAP = {}; }

// sadə dedup
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
    const sig = req.get('x-webhook-signature');
    if (!sig || sig !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    res.status(200).json({ received: true });

    const { event, data } = req.body || {};
    if (event !== 'messages-group.received') return;

    const remoteJid   = data?.key?.remoteJid;
    const participant = data?.key?.participant; // "...@s.whatsapp.net"
    const msgId       = data?.key?.id;
    const fromMe      = !!data?.key?.fromMe;
    const msg         = data?.message || {};

    if (!remoteJid || !GROUP_MAP[remoteJid]) return;
    if (fromMe) return;

    const { admin: adminMsisdn, courier: courierMsisdn } = GROUP_MAP[remoteJid];

    // göndərənin rəqəmləri
    const senderDigits = String(participant || '').replace(/@.*/, '').replace(/\D/g, '');
    const isAdmin = senderDigits.endsWith(String(adminMsisdn || ''));

    if (!isAdmin) return; // yalnız adminin sablon mesajını emal edirik

    if (seenRecently(msgId)) return;

    const text =
      msg.conversation ||
      msg.extendedTextMessage?.text ||
      msg.imageMessage?.caption ||
      msg.videoMessage?.caption ||
      '';

    if (!text) return;

    // BÜTÜN nömrələri çıxar və hamısına göndər
    const recipients = extractAllPhones(text);
    if (!recipients.length) {
      console.log('⚠️ Nömrə tapılmadı. text=', text);
      return;
    }

    const courierHuman = courierMsisdn?.startsWith('994')
      ? '+' + courierMsisdn
      : courierMsisdn || '';

    const body = `Sifarişiniz ${courierHuman} tərəfindən qəbul edildi.`;

    // (istəsən limit qoya bilərsən: recipients.slice(0, 30))
    const tasks = recipients.map(num => sendText({ to: num, text: body }));
    const results = await Promise.allSettled(tasks);

    const ok = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.length - ok;

    console.log(`✅ Göndərildi: ${ok}, ❌ Uğursuz: ${fail}`, { group: remoteJid, total: results.length });
  } catch (e) {
    console.error('Webhook handler error:', e?.response?.data || e.message);
  }
});

const PORT = process.env.PORT || 4243;
app.listen(PORT, () => {
  const mask = s => (s ? s.slice(0, 6) + '***' : '[absent]');
  console.log(`Bridge running on :${PORT}`);
  console.log('GROUP_MAP groups:', Object.keys(GROUP_MAP).length);
  console.log('WASENDER_API_KEY   =>', mask(process.env.WASENDER_API_KEY));
});

