// Démarrage / arrêt du bot Telegram (long polling), pilotable depuis le panneau admin
import { tg } from './telegram.js';
import { getSetting } from './config.js';
import { getFan, updateFan, resetFan, stats, addMessage, adminUpdateFan } from './db.js';
import { setRoute, routeOf, businessInfo, saveBusinessInfo, defaultConnId } from './business.js';
import { onFanTurn, onPurchase } from './engine.js';
import { replyDelay, TYPING_MS, MODES, currentMode } from './timing.js';

const state = { running: false, username: null, error: null, controller: null };
export const botStatus = () => ({ running: state.running, username: state.username, error: state.error });

// File d'attente par fan : ses messages sont traités un par un, dans l'ordre
const queues = new Map();
function enqueue(userId, job) {
  const next = (queues.get(userId) || Promise.resolve()).then(job)
    .catch((e) => console.error(`[fan ${userId}]`, e.message));
  queues.set(userId, next);
  next.finally(() => queues.get(userId) === next && queues.delete(userId));
}

// Messages du fan en attente de réponse : on attend le délai du mode (humain / occupée / très occupée),
// puis la modèle répond UNE fois à tout ce qu'il a envoyé entre-temps.
const pending = new Map(); // userId -> { user, texts: [] }
function scheduleReply(user, text) {
  let p = pending.get(user.id);
  if (p) { p.texts.push(text); return; } // un timer tourne déjà : on regroupe
  p = { user, texts: [text] };
  pending.set(user.id, p);
  const delay = replyDelay();
  setTimeout(() => {
    tg('sendChatAction', { chat_id: user.id, action: 'typing' }).catch(() => {});
    enqueue(user.id, async () => {
      pending.delete(user.id);
      await onFanTurn(p.user, p.texts.join('\n'));
    });
  }, Math.max(1000, delay - TYPING_MS));
}

const AGE_GATE = {
  text: "Coucou 👋 Avant de commencer : ce chat est réservé aux personnes majeures et il est animé par une IA. Tu confirmes avoir 18 ans ou plus ?",
  reply_markup: { inline_keyboard: [[{ text: "✅ J'ai 18 ans ou plus", callback_data: 'age_ok' }]] },
};

async function handleAdmin(msg) {
  const text = msg.text || '';
  if (text === '/stats') {
    const s = await stats();
    await tg('sendMessage', {
      chat_id: msg.chat.id,
      text: `👥 Fans : ${s.fans}\n🔥 En phase 2 : ${s.phase2}\n📤 PPV envoyés : ${s.ppvSent}\n💰 PPV payés : ${s.ppvPaid}\n⭐ Stars : ${s.stars}`,
    });
    return true;
  }
  if (text.startsWith('/mode')) {
    const arg = text.split(' ')[1];
    const map = { humain: 'human', human: 'human', occupe: 'busy', occupee: 'busy', busy: 'busy', tres: 'very_busy', very_busy: 'very_busy' };
    if (map[arg]) {
      const { saveSettings } = await import('./config.js');
      await saveSettings({ RESPONSE_MODE: map[arg] });
    }
    const m = MODES[currentMode()];
    await tg('sendMessage', { chat_id: msg.chat.id, text: `⏱️ Mode : ${m.label} (${m.min}–${m.max} s)\nChanger : /mode humain · /mode occupee · /mode tres` });
    return true;
  }
  if (text === '/reset') {
    await resetFan(msg.from.id);
    await tg('sendMessage', { chat_id: msg.chat.id, text: 'Conversation réinitialisée. Envoie /start.' });
    return true;
  }
  return false;
}

// Texte lisible pour l'IA à partir d'un message Telegram
const textOf = (msg) => (msg.photo || msg.video) && msg.caption
  ? `${msg.caption} (+ ${msg.photo ? 'une photo' : 'une vidéo'} que tu ne peux pas voir)`
  : msg.text || msg.caption
  || (msg.photo && '(le fan a envoyé une photo — tu ne peux PAS la voir)')
  || (msg.video && '(le fan a envoyé une vidéo — tu ne peux PAS la voir)')
  || (msg.voice && '(le fan a envoyé un vocal — tu ne peux PAS l\'écouter)')
  || (msg.sticker && `[sticker ${msg.sticker.emoji || ''}]`)
  || '[message]';

const ageGateOn = () => getSetting('AGE_GATE') === 'on';

// Message d'un fan (direct au bot, ou au compte perso via Telegram Business)
async function incomingFan(msg, connId) {
  const text = textOf(msg);
  const from = msg.from;
  setRoute(from.id, connId); // on répondra par le même canal
  enqueue(from.id, async () => {
    const fan = await getFan(from);
    const isCmd = msg.text?.startsWith('/');

    // Vérif 18+ (optionnelle, bot direct uniquement)
    if (!fan.adult_ok) {
      if (ageGateOn() && !connId) return tg('sendMessage', { chat_id: msg.chat.id, ...AGE_GATE });
      await updateFan(fan.id, { adult_ok: true });
    }
    if (isCmd && msg.text !== '/start') return; // autres commandes : ignorées
    const t = isCmd ? '(le fan vient d\'ouvrir la conversation)' : text;
    await addMessage(fan.id, 'user', t);
    scheduleReply(from, t);
  });
}

// Telegram Business : récupère (et met en cache) les infos de la connexion
async function connectionInfo(connId) {
  let info = businessInfo();
  if (info?.id === connId && info.ownerId) return info;
  const conn = await tg('getBusinessConnection', { business_connection_id: connId }).catch(() => null);
  return conn ? saveBusinessInfo(conn) : info;
}

async function handleBusinessMessage(msg) {
  const connId = msg.business_connection_id;
  if (!connId || msg.chat.type !== 'private') return;
  if (msg.sender_business_bot) return; // écho de nos propres messages
  const info = await connectionInfo(connId);

  // C'est TOI qui écris depuis ton compte perso : le bot se met en pause pour ce fan
  if (info?.ownerId && msg.from?.id === info.ownerId) {
    const fanId = msg.chat.id;
    enqueue(fanId, async () => {
      await getFan({ id: fanId, first_name: msg.chat.first_name, username: msg.chat.username });
      await addMessage(fanId, 'assistant', textOf(msg));
      const cur = await getFan({ id: fanId });
      if ((cur.status || 'active') === 'active') {
        await adminUpdateFan(fanId, { status: 'paused' });
        await addMessage(fanId, 'event', 'Tu as répondu toi-même : bot mis en pause pour ce fan (réactive-le dans l\'onglet Fans).');
      }
    });
    return;
  }
  if (info && info.canReply === false) return; // le bot n'a pas le droit de répondre
  return incomingFan(msg, connId);
}

async function handleUpdate(u) {
  if (u.business_connection) {
    const c = u.business_connection;
    await saveBusinessInfo(c.is_enabled === false ? null : c);
    console.log(`💼 Telegram Business ${c.is_enabled === false ? 'déconnecté' : 'connecté'} : ${c.user?.first_name || ''}`);
    return;
  }
  if (u.business_message) return handleBusinessMessage(u.business_message);

  if (u.purchased_paid_media) {
    const { from, paid_media_payload } = u.purchased_paid_media;
    const [, , via] = (paid_media_payload || '').split(':');
    if (via === 'b' && !routeOf(from.id)) setRoute(from.id, defaultConnId());
    const wait = Math.min(replyDelay(), 60000) - TYPING_MS;
    return setTimeout(() => enqueue(from.id, () => onPurchase(from, paid_media_payload)), Math.max(1000, wait));
  }

  if (u.callback_query) {
    const q = u.callback_query;
    await tg('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    if (q.data === 'age_ok') {
      enqueue(q.from.id, async () => {
        await getFan(q.from);
        await updateFan(q.from.id, { adult_ok: true });
        await tg('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
        await addMessage(q.from.id, 'user', 'coucou');
        scheduleReply(q.from, 'coucou');
      });
    }
    return;
  }

  const msg = u.message;
  if (!msg || msg.chat.type !== 'private') return;
  if (String(msg.from.id) === getSetting('ADMIN_TELEGRAM_ID') && (await handleAdmin(msg))) return;
  return incomingFan(msg, null);
}

async function loop(controller) {
  let offset = 0;
  while (!controller.signal.aborted) {
    try {
      const updates = await tg('getUpdates', {
        offset, timeout: 30, allowed_updates: ['message', 'callback_query', 'purchased_paid_media', 'business_connection', 'business_message'],
      }, { signal: controller.signal });
      for (const u of updates) {
        offset = u.update_id + 1;
        handleUpdate(u).catch((e) => console.error('update', e.message));
      }
    } catch (e) {
      if (controller.signal.aborted) break;
      console.error('poll', e.message);
      state.error = e.message;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

export async function startBot() {
  if (state.running) return botStatus();
  if (!getSetting('BOT_TOKEN')) {
    state.error = 'Token du bot manquant (Paramètres)';
    return botStatus();
  }
  try {
    const me = await tg('getMe');
    await tg('deleteWebhook').catch(() => {});
    state.controller = new AbortController();
    Object.assign(state, { running: true, username: me.username, error: null });
    console.log(`🤖 Bot @${me.username} démarré`);
    loop(state.controller).finally(() => { state.running = false; });
  } catch (e) {
    Object.assign(state, { running: false, error: e.message });
  }
  return botStatus();
}

export async function stopBot() {
  state.controller?.abort();
  state.running = false;
  console.log('⏹️  Bot arrêté');
  return botStatus();
}

export async function restartBot() {
  await stopBot();
  await new Promise((r) => setTimeout(r, 500));
  return startBot();
}
