// Paramètres modifiables depuis le panneau admin (stockés dans Supabase, table settings)
import { sb, check } from './supabase.js';

export const SETTING_KEYS = {
  BOT_TOKEN: { secret: true },
  ADMIN_TELEGRAM_ID: { secret: false },
  OPENROUTER_API_KEY: { secret: true },
  AI_MODEL: { secret: false, default: 'google/gemini-2.5-flash' },
  RESPONSE_MODE: { secret: false, default: 'human' }, // human | busy | very_busy
  AGE_GATE: { secret: false, default: 'off' },          // on | off (bouton 18+ au début)
  BUSINESS_INFO: { secret: false, hidden: true },       // connexion Telegram Business (JSON)
};

const cache = {};

export async function loadSettings() {
  const rows = check(await sb.from('settings').select('key, value'), 'settings');
  for (const k of Object.keys(SETTING_KEYS)) cache[k] = SETTING_KEYS[k].default ?? '';
  for (const r of rows) if (r.key in SETTING_KEYS && r.value) cache[r.key] = r.value;
}

export const getSetting = (k) => cache[k] ?? '';

export async function saveSettings(values) {
  const rows = Object.entries(values)
    .filter(([k, v]) => k in SETTING_KEYS && typeof v === 'string' && v.trim() !== '')
    .map(([key, value]) => ({ key, value: value.trim() }));
  if (!rows.length) return [];
  check(await sb.from('settings').upsert(rows), 'settings save');
  for (const r of rows) cache[r.key] = r.value;
  return rows.map((r) => r.key);
}

// Version affichable : les secrets ne sont jamais renvoyés en clair
export function publicSettings() {
  const out = {};
  for (const [k, meta] of Object.entries(SETTING_KEYS)) {
    const v = cache[k] || '';
    out[k] = meta.secret
      ? { set: !!v, hint: v ? `${v.slice(0, 4)}••••${v.slice(-3)}` : '' }
      : { set: !!v, value: v };
  }
  return out;
}
