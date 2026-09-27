// Funnel + persona : modifiables depuis le panneau admin, stockés dans Supabase (table settings)
// Valeurs par défaut = config/funnel.json et config/persona.json
import fs from 'node:fs';
import { sb, check } from './supabase.js';

const readDefault = (f) => JSON.parse(fs.readFileSync(new URL(`../config/${f}`, import.meta.url)));
const docs = { FUNNEL_JSON: null, PERSONA_JSON: null };

export async function loadDocs() {
  const rows = check(await sb.from('settings').select('key, value').in('key', Object.keys(docs)), 'docs');
  for (const r of rows) { try { docs[r.key] = JSON.parse(r.value); } catch { /* ignore */ } }
  docs.FUNNEL_JSON ??= readDefault('funnel.json');
  docs.PERSONA_JSON ??= readDefault('persona.json');
}

export const getFunnel = () => docs.FUNNEL_JSON;
export const getPersona = () => docs.PERSONA_JSON;

const TYPES = ['teaser_text', 'free_media', 'ppv', 'chat', 'end', 'stop'];

export async function validateFunnel(f) {
  const errs = [];
  if (!f || typeof f !== 'object' || !f.steps || typeof f.steps !== 'object') throw new Error('Funnel invalide');
  const ids = Object.keys(f.steps);
  if (!ids.length) errs.push('Ajoute au moins une étape');
  if (!f.steps[f.start]) errs.push(`Étape de départ "${f.start}" introuvable`);

  const mediaRows = check(await sb.from('media').select('name'), 'media');
  const known = new Set(mediaRows.map((m) => m.name));

  for (const [id, s] of Object.entries(f.steps)) {
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(id)) errs.push(`ID "${id}" invalide (lettres, chiffres, _ -)`);
    if (!TYPES.includes(s.type)) { errs.push(`${id} : type inconnu`); continue; }
    const ref = (key) => { if (s[key] && !f.steps[s[key]]) errs.push(`${id} : "${key}" pointe vers "${s[key]}" qui n'existe pas`); };
    if (s.type === 'free_media' || s.type === 'ppv') {
      if (!Array.isArray(s.media) || !s.media.length) errs.push(`${id} : choisis au moins un média`);
      else if (s.media.length > 10) errs.push(`${id} : 10 médias max`);
      else s.media.forEach((m) => { if (!known.has(m)) errs.push(`${id} : média "${m}" absent de la galerie`); });
    }
    if (s.type === 'ppv') {
      if (!Number.isInteger(s.stars) || s.stars < 1 || s.stars > 10000) errs.push(`${id} : prix entre 1 et 10 000 stars`);
      ref('onBuy'); ref('onNoBuy');
    } else if (s.type !== 'stop') ref('next');
    if (!['end', 'stop'].includes(s.type) && !String(s.instruction || '').trim()) errs.push(`${id} : consigne vide`);
  }
  if (errs.length) throw new Error(errs.join('\n'));
}

async function save(key, value) {
  check(await sb.from('settings').upsert({ key, value: JSON.stringify(value) }), 'save ' + key);
  docs[key] = value;
}

export async function saveFunnel(f) { await validateFunnel(f); await save('FUNNEL_JSON', f); }

export async function savePersona(p) {
  const n = Number(p.phase1Messages);
  if (!String(p.name || '').trim()) throw new Error('Nom obligatoire');
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('Messages de phase 1 : entre 1 et 50');
  await save('PERSONA_JSON', { ...p, phase1Messages: n, age: Number(p.age) || p.age });
}

// Étapes qui utilisent un média
export function stepsUsingMedia(name) {
  return Object.entries(getFunnel().steps).filter(([, s]) => (s.media || []).includes(name)).map(([id]) => id);
}

// Renommage d'un média : met à jour le funnel automatiquement
export async function renameMediaInFunnel(oldName, newName) {
  const f = getFunnel();
  let changed = false;
  for (const s of Object.values(f.steps)) {
    if (s.media?.includes(oldName)) { s.media = s.media.map((m) => (m === oldName ? newName : m)); changed = true; }
  }
  if (changed) await save('FUNNEL_JSON', f);
}
