// Moteur : Phase 1 (discussion) -> Phase 2 (funnel de vente)
import { generate, persona, detectLang, translate } from './ai.js';
import { tg, typeAndSend } from './telegram.js';
import { sendFreeMedia, sendPaidMedia, describeMedia } from './gallery.js';
import { getFan, updateFan, addMessage, getHistory, logSale, countSends } from './db.js';
import { getSetting } from './config.js';
import { getFunnel as funnel } from './store.js';
import { routeOf } from './business.js';

// payload du PPV : fan:étape(:b si envoyé depuis le compte perso Telegram Business)
const payloadFor = (fan, stepId) => `${fan.id}:${stepId}${routeOf(fan.id) ? ':b' : ''}`;

// Le fan dit être mineur : on arrête tout de suite la conversation
const MINOR_RE = /\b(j'?ai|jai|g|j ai)\s*(1[0-7]|[0-9])\s*ans\b|\bje suis (mineur|mineure)\b|\bi'?m (1[0-7])\b/i;

// Le fan réclame du contenu : on accélère le funnel au lieu de le faire attendre
const CONTENT_RE = /\b(photos?|pics?|pictures?|vid[ée]os?|nudes?|montre|montrer|envoie|send|voir (plus|d'?autres?|tes|ta))\b/i;

const NO_MEDIA = "Aucun média n'est prévu à ce moment. Si le fan en réclame, fais-le patienter de façon taquine sans promettre d'envoi.";
const RESEND_RE = /(renvoi|renvoie|rien vu|rien re[çc]u|vois (rien|pas)|voit (rien|pas)|pas re[çc]u|pas vu|o[uù] (ça|ca|est)|marche pas|s'affiche pas|resend|can'?t see)/i;

// Une ligne vide dans la réponse = messages Telegram séparés (comme une vraie personne), 3 max
// Max 2 bulles, et max 2 phrases par bulle (évite les pavés)
const firstSentences = (t, n = 2) => (t.match(/[^.!?…]+[.!?…]*[\s\p{Extended_Pictographic}\u{FE0F}]*/gu) || [t]).slice(0, n).join('').trim();
export function splitBubbles(text) {
  let parts = text.split(/\n\s*\n+/).map((t) => t.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  if (!parts.length) parts = [text.trim()];
  return parts.slice(0, 2).map((p) => firstSentences(p, 2));
}

async function say(fan, directive, situation = NO_MEDIA) {
  const text = await generate(directive, fan, await getHistory(fan.id), situation);
  const bubbles = splitBubbles(text);
  for (const b of bubbles) await typeAndSend(fan.id, b);
  await addMessage(fan.id, 'assistant', bubbles.join('\n'));
  return text;
}

// Journal interne (visible par l'IA comme contexte, jamais comme message à imiter)
const logEvent = (fan, text) => addMessage(fan.id, 'event', text);

// Prévient l'admin sur Telegram en cas d'erreur (1 fois par étape)
const notified = new Set();
async function alertAdmin(fan, stepId, err) {
  console.error(`[fan ${fan.id}] étape ${stepId} :`, err.message);
  const admin = getSetting('ADMIN_TELEGRAM_ID');
  const key = `${fan.id}:${stepId}`;
  if (!admin || notified.has(key)) return;
  notified.add(key);
  await tg('sendMessage', { chat_id: admin, text: `⚠️ Étape ${stepId} impossible pour ${fan.first_name || fan.id} :\n${err.message}` }).catch(() => {});
}

function ppvSituation(step, stepId) {
  return `Un contenu privé FLOUTÉ (légende « ${step.caption || ''} », prix ${step.stars} étoiles Telegram) a DÉJÀ été envoyé plus haut. `
    + `Il n'est pas encore débloqué. Pour le voir, le fan appuie sur le média flouté puis sur « Débloquer ». Ce n'est pas un lien. `
    + `Ne le re-propose pas comme si c'était nouveau. `
    + `Si le fan dit que c'est flou / payant / demande le prix : confirme que c'est ton contenu privé, donne le prix (${step.stars} étoiles) et donne-lui envie (ce qu'il va voir), sans changer de sujet. `
    + `S'il dit qu'il n'a pas d'argent : n'insiste pas, sois gentille et passe à autre chose.`;
}

// Légende du PPV dans la langue du fan
async function captionFor(fan, step) {
  const lang = detectLang(await getHistory(fan.id, 10));
  return lang === 'fr' ? step.caption : translate(step.caption, lang);
}

// Passe à une étape ; si afterMessages = 0 elle s'exécute tout de suite
async function goTo(fan, stepId) {
  Object.assign(fan, { step_id: stepId, step_msgs: 0, step_done: false });
  await updateFan(fan.id, { step_id: stepId, step_msgs: 0, step_done: false });
  const step = funnel().steps[stepId];
  if (step && (step.afterMessages ?? 1) === 0) await executeStep(fan, stepId, step);
}

async function executeStep(fan, stepId, step) {
  try {
    switch (step.type) {
      case 'teaser_text':
      case 'chat':
        await say(fan, step.instruction);
        break;

      case 'free_media': {
        const desc = await describeMedia(step.media);
        const caption = await generate(
          `${step.instruction}\nTon message est la LÉGENDE de ${desc} GRATUITE(S) envoyée(s) avec : il DOIT présenter ce média comme un petit cadeau pour lui (1 ou 2 phrases, pas de question sans rapport).`,
          fan, await getHistory(fan.id),
          `Le système envoie ${desc} GRATUITE(S) avec ton message comme légende. Le fan la/les verra directement.`,
        );
        const cap = splitBubbles(caption).join(' ');
        await sendFreeMedia(fan.id, step.media, cap);
        await addMessage(fan.id, 'assistant', cap);
        await logEvent(fan, `${desc} GRATUITE(S) envoyée(s), le fan la/les voit directement.`);
        break;
      }

      case 'ppv': {
        const desc = await describeMedia(step.media);
        await say(fan, `${step.instruction}\nTon message DOIT annoncer que tu lui envoies juste en dessous ${desc} privée(s) (floutée(s)). Pas de question sans rapport, reste sur ce contenu.`,
          `Juste après ton message, le système envoie ${desc} FLOUTÉE(S) payante(s) (${step.stars} étoiles Telegram) que le fan pourra débloquer.`);
        await sendPaidMedia(fan.id, step.media, step.stars, await captionFor(fan, step), payloadFor(fan, stepId));
        await logEvent(fan, `Contenu PRIVÉ FLOUTÉ envoyé : ${desc}, légende « ${step.caption || ''} », ${step.stars} étoiles — en attente de déblocage.`);
        await logSale(fan.id, stepId, step.stars, 'sent');
        break;
      }

      case 'stop':
        // Dernier message (optionnel) puis la modèle ne répond plus à ce fan
        if (String(step.instruction || '').trim()) await say(fan, step.instruction);
        fan.status = 'stopped';
        await updateFan(fan.id, { status: 'stopped', step_done: true });
        await logEvent(fan, 'Conversation arrêtée (étape stop).');
        return;

      case 'end':
      default:
        await say(fan, step.instruction || persona().freeChatInstruction);
        return; // pas de changement d'état
    }
  } catch (e) {
    // Le média n'a pas pu partir : on prévient l'admin et on ne laisse pas le fan sans réponse.
    // L'étape sera retentée au prochain message du fan.
    await alertAdmin(fan, stepId, e);
    await say(fan, persona().freeChatInstruction).catch(() => {});
    return;
  }

  fan.step_done = true;
  await updateFan(fan.id, { step_done: true });
  if (step.type !== 'ppv' && step.next) await goTo(fan, step.next);
}

// Le fan dit qu'il ne voit pas le PPV : on le renvoie (1 fois max)
async function resendPpv(fan, stepId, step) {
  if ((await countSends(fan.id, stepId)) >= 2) return false;
  await say(fan, 'Le fan dit ne pas voir ton contenu. Dis-lui en une phrase que tu le lui remets juste en dessous et qu\'il suffit d\'appuyer dessus pour le débloquer.',
    'Juste après ton message, le système renvoie le contenu flouté.');
  await sendPaidMedia(fan.id, step.media, step.stars, await captionFor(fan, step), payloadFor(fan, stepId));
  await logEvent(fan, `Contenu PRIVÉ FLOUTÉ renvoyé (légende « ${step.caption || ''} »).`);
  await logSale(fan.id, stepId, step.stars, 'resent');
  return true;
}

// Un "tour" du fan : ses messages (déjà enregistrés) reçus pendant le délai de réponse
export async function onFanTurn(user, text) {
  const fan = await getFan(user);
  if (fan.status && fan.status !== 'active') return; // en pause / stoppé : pas de réponse
  if (MINOR_RE.test(text)) {
    await typeAndSend(fan.id, "désolée, je ne discute qu'avec des personnes majeures. prends soin de toi 🙏");
    await updateFan(fan.id, { status: 'stopped' });
    await addMessage(fan.id, 'event', 'Le fan a indiqué être mineur : conversation stoppée automatiquement.');
    await alertAdmin(fan, 'mineur', new Error('Le fan a indiqué être mineur : conversation stoppée.'));
    return;
  }
  const p = persona();

  // ---------- PHASE 1 ----------
  if (fan.phase === 1) {
    // Il réclame déjà des photos : on passe directement au funnel (au moins 2 échanges avant)
    if (CONTENT_RE.test(text) && fan.phase1_count >= 2) {
      await updateFan(fan.id, { phase: 2, phase1_count: fan.phase1_count + 1 });
      fan.phase = 2;
      const start = funnel().start;
      await goTo(fan, start);
      const st = funnel().steps[start];
      if (st && !fan.step_done && fan.status !== 'stopped') return executeStep(fan, start, st);
      return;
    }
    await say(fan, p.phase1Instruction);
    const count = fan.phase1_count + 1;
    if (count >= p.phase1Messages) {
      await updateFan(fan.id, { phase: 2, phase1_count: count });
      fan.phase = 2;
      await goTo(fan, funnel().start);
    } else {
      await updateFan(fan.id, { phase1_count: count });
    }
    return;
  }

  // ---------- PHASE 2 ----------
  const steps = funnel().steps;
  const stepId = fan.step_id || funnel().start;
  const step = steps[stepId];
  if (!step) return say(fan, p.freeChatInstruction);

  const msgs = fan.step_msgs + 1;
  fan.step_msgs = msgs;
  await updateFan(fan.id, { step_msgs: msgs });

  if (step.type === 'end') {
    // Fin du funnel : après X messages, la modèle arrête de répondre (évite des heures de discussion sans vente)
    if (step.maxMessages && msgs > step.maxMessages) {
      await updateFan(fan.id, { status: 'stopped' });
      return logEvent(fan, `Fin du funnel : arrêt automatique après ${step.maxMessages} messages.`);
    }
    return executeStep(fan, stepId, step);
  }

  // Étape pas encore exécutée
  if (!fan.step_done) {
    const eager = CONTENT_RE.test(text) && ['teaser_text', 'free_media', 'ppv'].includes(step.type);
    if (msgs >= (step.afterMessages ?? 1) || eager) return executeStep(fan, stepId, step);
    return say(fan, step.chatInstruction || p.freeChatInstruction);
  }

  // PPV envoyé, en attente d'achat
  if (step.type === 'ppv') {
    if (RESEND_RE.test(text)) {
      try { if (await resendPpv(fan, stepId, step)) return; } catch (e) { await alertAdmin(fan, stepId, e); }
    }
    if (msgs > (step.maxWaitMessages ?? 4)) {
      await goTo(fan, step.onNoBuy || 'END'); // pas d'achat -> script X
      if (!fan.step_done) await say(fan, steps[fan.step_id]?.chatInstruction || p.freeChatInstruction);
      return;
    }
    return say(fan, step.waitingInstruction || p.freeChatInstruction, ppvSituation(step, stepId));
  }

  return say(fan, p.freeChatInstruction);
}

// Update Telegram "purchased_paid_media"
export async function onPurchase(user, payload) {
  const [fanIdStr, stepId] = (payload || '').split(':');
  const fan = await getFan(user);
  if (Number(fanIdStr) !== Number(fan.id)) return;
  const step = funnel().steps[stepId];
  if (!step) return;

  await logSale(fan.id, stepId, step.stars, 'paid');
  await updateFan(fan.id, { total_stars: fan.total_stars + step.stars, purchases: fan.purchases + 1 });
  await logEvent(fan, `Le fan a DÉBLOQUÉ (acheté) le contenu « ${step.caption || ''} ». Il le voit maintenant.`);

  if (fan.status && fan.status !== 'active') return; // achat enregistré, mais pas de réponse
  await say(fan, step.thanksInstruction || 'Remercie le fan pour son achat.',
    'Le fan vient d\'acheter et voit maintenant le contenu. Aucun autre média n\'est envoyé maintenant.');

  if (fan.step_id === stepId) await goTo(fan, step.onBuy || 'END'); // achat -> script B
}
