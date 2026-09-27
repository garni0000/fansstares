// Délai de réponse "humain" : la modèle lit et répond après un temps variable selon le mode choisi
import { getSetting } from './config.js';

export const MODES = {
  human: { label: 'Humain', min: 15, max: 20 },        // secondes
  busy: { label: 'Occupée', min: 60, max: 120 },
  very_busy: { label: 'Très occupée', min: 180, max: 300 },
};

export const TYPING_MS = 3500; // temps "en train d'écrire…" inclus dans le délai

export function currentMode() {
  return MODES[getSetting('RESPONSE_MODE')] ? getSetting('RESPONSE_MODE') : 'human';
}

// Délai total (ms) entre la réception du message et la réponse
export function replyDelay() {
  const { min, max } = MODES[currentMode()];
  return Math.round((min + Math.random() * (max - min)) * 1000);
}
