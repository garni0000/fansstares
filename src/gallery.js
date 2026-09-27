// Galerie : dossier local ./galerie <-> Supabase Storage (bucket privé) + table media
import fs from 'node:fs';
import path from 'node:path';
import { sb, check, BUCKET } from './supabase.js';
import { getSetting } from './config.js';
import { tg, extractFileIds } from './telegram.js';

export const GALLERY_DIR = path.resolve('galerie');
const EXT = {
  '.jpg': ['photo', 'image/jpeg'], '.jpeg': ['photo', 'image/jpeg'], '.png': ['photo', 'image/png'],
  '.webp': ['photo', 'image/webp'], '.mp4': ['video', 'video/mp4'], '.mov': ['video', 'video/quicktime'],
};
const MAX_SIZE = 50 * 1024 * 1024; // limite d'upload des bots Telegram

// "Shooting Plage 01.jpg" -> "shooting_plage_01"
export function toName(filename) {
  return path.parse(filename).name.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'media';
}

export function detect(filename, mime) {
  const e = EXT[path.extname(filename).toLowerCase()];
  if (e) return { type: e[0], mime: e[1] };
  if (mime?.startsWith('image/')) return { type: 'photo', mime };
  if (mime?.startsWith('video/')) return { type: 'video', mime };
  return null;
}

export async function ensureBucket() {
  const { data } = await sb.storage.getBucket(BUCKET);
  if (!data) {
    const { error } = await sb.storage.createBucket(BUCKET, { public: false });
    if (error && !/exists/i.test(error.message)) {
      console.error(`⚠️  Bucket "${BUCKET}" introuvable et impossible à créer (${error.message}). Crée-le dans Supabase > Storage (privé).`);
    }
  }
}

export async function listMedia() {
  const rows = check(await sb.from('media').select('*').order('created_at', { ascending: false }), 'listMedia');
  if (!rows.length) return [];
  const signed = check(await sb.storage.from(BUCKET).createSignedUrls(rows.map((r) => r.path), 3600), 'signedUrls');
  return rows.map((r, i) => ({ ...r, url: signed[i]?.signedUrl || null }));
}

export async function addMedia({ buffer, filename, mime, name }) {
  const kind = detect(filename, mime);
  if (!kind) throw new Error(`Format non supporté : ${filename} (jpg, png, webp, mp4, mov)`);
  if (buffer.length > MAX_SIZE) throw new Error(`${filename} dépasse 50 Mo (limite Telegram)`);

  const finalName = toName(name || filename);
  const existing = check(await sb.from('media').select('*').eq('name', finalName).maybeSingle(), 'media');
  const storagePath = `${finalName}${path.extname(filename).toLowerCase()}`;

  check(await sb.storage.from(BUCKET).upload(storagePath, buffer, { contentType: kind.mime, upsert: true }), 'upload');

  const row = {
    name: finalName, type: kind.type, path: storagePath, mime: kind.mime, size: buffer.length,
    tg_file_id: null, tg_bot_id: null, // nouveau fichier -> nouveau file_id
  };
  if (existing) {
    if (existing.path !== storagePath) await sb.storage.from(BUCKET).remove([existing.path]);
    return check(await sb.from('media').update(row).eq('id', existing.id).select().single(), 'media update');
  }
  return check(await sb.from('media').insert(row).select().single(), 'media insert');
}

export async function renameMedia(id, newName) {
  const name = toName(newName);
  return check(await sb.from('media').update({ name }).eq('id', id).select().single(), 'rename');
}

export async function deleteMedia(id) {
  const row = check(await sb.from('media').select('*').eq('id', id).single(), 'media');
  await sb.storage.from(BUCKET).remove([row.path]);
  check(await sb.from('media').delete().eq('id', id), 'delete');
}

// Envoie dans Supabase les fichiers du dossier ./galerie pas encore présents (ou modifiés)
export async function syncFolder() {
  fs.mkdirSync(GALLERY_DIR, { recursive: true });
  const files = fs.readdirSync(GALLERY_DIR).filter((f) => detect(f) && !f.startsWith('.'));
  const rows = check(await sb.from('media').select('name, size'), 'media');
  const known = new Map(rows.map((r) => [r.name, r.size]));
  const report = { added: [], updated: [], skipped: [], errors: [] };

  for (const f of files) {
    const full = path.join(GALLERY_DIR, f);
    const size = fs.statSync(full).size;
    const name = toName(f);
    if (known.get(name) === size) { report.skipped.push(name); continue; }
    try {
      await addMedia({ buffer: fs.readFileSync(full), filename: f });
      (known.has(name) ? report.updated : report.added).push(name);
    } catch (e) {
      report.errors.push(`${f}: ${e.message}`);
    }
  }
  return report;
}

// Surveille le dossier et synchronise automatiquement quand tu ajoutes un fichier
export function watchFolder() {
  fs.mkdirSync(GALLERY_DIR, { recursive: true });
  let timer;
  fs.watch(GALLERY_DIR, () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const r = await syncFolder();
        if (r.added.length || r.updated.length) console.log('🖼️  Galerie synchronisée :', [...r.added, ...r.updated].join(', '));
        if (r.errors.length) console.error('Galerie :', r.errors.join(' | '));
      } catch (e) { console.error('Galerie sync', e.message); }
    }, 1500);
  });
}

// ---------- Envoi Telegram depuis la galerie ----------

const botId = () => Number(getSetting('BOT_TOKEN').split(':')[0]);

// Transforme ["shooting1", "video2"] en médias prêts à envoyer (file_id en cache ou fichier à uploader)
async function prepare(names) {
  const rows = check(await sb.from('media').select('*').in('name', names), 'media');
  const byName = new Map(rows.map((r) => [r.name, r]));
  const items = [];
  for (const [i, n] of names.entries()) {
    const row = byName.get(n);
    if (!row) throw new Error(`Média "${n}" introuvable dans la galerie`);
    if (row.tg_file_id && Number(row.tg_bot_id) === botId()) {
      items.push({ row, ref: row.tg_file_id });
    } else {
      const blob = check(await sb.storage.from(BUCKET).download(row.path), 'download');
      items.push({
        row, ref: `attach://file${i}`,
        file: { field: `file${i}`, buffer: Buffer.from(await blob.arrayBuffer()), mime: row.mime, filename: row.path },
      });
    }
  }
  return items;
}

// Mémorise les file_id pour ne plus ré-uploader ensuite
async function cache(items, result) {
  const ids = extractFileIds(result);
  await Promise.all(items.map((it, i) => (!it.file || !ids[i]) ? null
    : sb.from('media').update({ tg_file_id: ids[i], tg_bot_id: botId() }).eq('id', it.row.id)));
}

export async function sendFreeMedia(chatId, names, caption) {
  const items = await prepare(names);
  const files = items.filter((i) => i.file).map((i) => i.file);
  let result;
  if (items.length === 1) {
    const it = items[0];
    const method = it.row.type === 'video' ? 'sendVideo' : 'sendPhoto';
    result = await tg(method, { chat_id: chatId, [it.row.type]: it.ref, caption }, { files });
  } else {
    const media = items.map((it, i) => ({ type: it.row.type, media: it.ref, ...(i === 0 && caption ? { caption } : {}) }));
    result = await tg('sendMediaGroup', { chat_id: chatId, media }, { files });
  }
  await cache(items, result);
  return result;
}

// Médias floutés débloquables en Telegram Stars
export async function sendPaidMedia(chatId, names, stars, caption, payload) {
  const items = await prepare(names);
  const files = items.filter((i) => i.file).map((i) => i.file);
  const media = items.map((it) => ({ type: it.row.type, media: it.ref }));
  const result = await tg('sendPaidMedia', { chat_id: chatId, star_count: stars, media, caption, payload }, { files });
  await cache(items, result);
  return result;
}

// "1 photo", "2 photos et 1 vidéo"… (pour que l'IA annonce le bon type de média)
export async function describeMedia(names = []) {
  const { data } = await sb.from('media').select('name, type').in('name', names);
  const types = (data || []).map((m) => m.type);
  const p = types.filter((t) => t === 'photo').length, v = types.filter((t) => t === 'video').length;
  const parts = [];
  if (p) parts.push(`${p} photo${p > 1 ? 's' : ''}`);
  if (v) parts.push(`${v} vidéo${v > 1 ? 's' : ''}`);
  return parts.join(' et ') || `${names.length} média(s)`;
}
