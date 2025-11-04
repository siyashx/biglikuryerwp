// forwarder.js
import axios from 'axios';

const WAS_BASE = process.env.WASENDER_API_BASE || 'https://www.wasenderapi.com';
const API_KEY = process.env.WASENDER_API_KEY;

export async function sendText({ to, text }) {
  if (process.env.DRY_RUN) {
    console.log('[DRY_RUN] would send =>', { to, text });
    return { success: true, data: { status: 'in_progress' } };
  }

  const payload = { to, text };
  try {
    const res = await axios.post(`${WAS_BASE}/api/send-message`, payload, {
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    return res.data;
  } catch (e) {
    // üst səviyyədə detallı log üçün throw et
    throw e;
  }
}

