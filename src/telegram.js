// Client Telegram Bot API minimal (fetch natif) — gère JSON et upload multipart
import { getSetting } from './config.js';
import { routeOf } from './business.js';

// Méthodes qui peuvent partir "au nom" du compte perso (Telegram Business)
const BIZ_METHODS = new Set(['sendMessage', 'sendChatAction', 'sendPhoto', 'sendVideo', 'sendMediaGroup', 'sendPaidMedia']);

export async function tg(method, params = {}, { files = [], signal, token } = {}) {
  if (BIZ_METHODS.has(method) && params.chat_id && !params.business_connection_id) {
    const conn = routeOf(params.chat_id);
    if (conn) params = { ...params, business_connection_id: conn };
  }
  const url = `https://api.telegram.org/bot${token || getSetting('BOT_TOKEN')}/${method}`;
  let init;
  if (files.length) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    for (const f of files) fd.append(f.field, new Blob([f.buffer], { type: f.mime }), f.filename);
    init = { method: 'POST', body: fd, signal };
  } else {
    init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal };
  }
  const res = await fetch(url, init);
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Simule une frappe humaine : "écrit..." puis délai proportionnel à la longueur
export async function typeAndSend(chatId, text, extra = {}) {
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  await sleep(Math.min(1500 + text.length * 25, 3500));
  return tg('sendMessage', { chat_id: chatId, text, ...extra });
}

// Récupère les file_id des médias dans un message renvoyé par Telegram
export function extractFileIds(result) {
  const msgs = Array.isArray(result) ? result : [result];
  const ids = [];
  for (const m of msgs) {
    if (m.paid_media) {
      for (const p of m.paid_media.paid_media) {
        ids.push(p.type === 'photo' ? p.photo?.at(-1)?.file_id : p.type === 'video' ? p.video?.file_id : null);
      }
    } else if (m.photo) ids.push(m.photo.at(-1).file_id);
    else if (m.video) ids.push(m.video.file_id);
    else ids.push(null);
  }
  return ids;
}
