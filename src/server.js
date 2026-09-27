// Panneau admin : API + page web (public/admin.html)
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { loadSettings, saveSettings, publicSettings } from './config.js';
import { listMedia, addMedia, renameMedia, deleteMedia, syncFolder } from './gallery.js';
import { botStatus, startBot, stopBot, restartBot } from './bot.js';
import { tg } from './telegram.js';
import { stats, listFans, fanMessages, adminUpdateFan, resetFan } from './db.js';
import { getFunnel, getPersona, saveFunnel, savePersona, stepsUsingMedia, renameMediaInFunnel } from './store.js';
import { sb } from './supabase.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export function createServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.resolve('public')));
  app.get('/', (_, res) => res.sendFile(path.resolve('public/admin.html')));

  // Auth simple par mot de passe (ADMIN_PASSWORD dans le .env)
  app.use('/api', (req, res, next) => {
    if (req.get('x-admin-password') !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Mot de passe incorrect' });
    next();
  });

  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(400).json({ error: e.message }));

  app.get('/api/ping', (_, res) => res.json({ ok: true }));

  // ---------- Paramètres ----------
  app.get('/api/settings', (_, res) => res.json(publicSettings()));
  app.put('/api/settings', wrap(async (req, res) => {
    const body = { ...(req.body || {}) };
    delete body.BUSINESS_INFO;
    if (body.AGE_GATE && !['on', 'off'].includes(body.AGE_GATE)) delete body.AGE_GATE;
    if (body.BOT_TOKEN) await tg('getMe', {}, { token: body.BOT_TOKEN.trim() }).catch(() => {
      throw new Error('Token du bot invalide');
    });
    const changed = await saveSettings(body);
    await loadSettings();
    if (changed.includes('BOT_TOKEN')) await restartBot();
    res.json({ changed, settings: publicSettings(), bot: botStatus() });
  }));

  // ---------- Bot ----------
  app.get('/api/bot', (_, res) => res.json(botStatus()));
  app.post('/api/bot/start', wrap(async (_, res) => res.json(await startBot())));
  app.post('/api/bot/stop', wrap(async (_, res) => res.json(await stopBot())));

  // ---------- Galerie ----------
  app.get('/api/media', wrap(async (_, res) => res.json(await listMedia())));
  app.post('/api/media', upload.array('files', 20), wrap(async (req, res) => {
    const out = [];
    for (const f of req.files || []) {
      const name = req.files.length === 1 && req.body.name ? req.body.name : f.originalname;
      out.push(await addMedia({ buffer: f.buffer, filename: f.originalname, mime: f.mimetype, name }));
    }
    res.json(out);
  }));
  const mediaName = async (id) => (await sb.from('media').select('name').eq('id', id).single()).data?.name;
  app.patch('/api/media/:id', wrap(async (req, res) => {
    const old = await mediaName(req.params.id);
    const row = await renameMedia(req.params.id, req.body.name);
    if (old && old !== row.name) await renameMediaInFunnel(old, row.name);
    res.json(row);
  }));
  app.delete('/api/media/:id', wrap(async (req, res) => {
    const used = stepsUsingMedia(await mediaName(req.params.id));
    if (used.length) throw new Error(`Utilisé dans le funnel (étape ${used.join(', ')}). Retire-le d'abord.`);
    await deleteMedia(req.params.id);
    res.json({ ok: true });
  }));
  app.post('/api/media/sync', wrap(async (_, res) => res.json(await syncFolder())));

  // ---------- Funnel + persona ----------
  app.get('/api/funnel', (_, res) => res.json(getFunnel()));
  app.put('/api/funnel', wrap(async (req, res) => { await saveFunnel(req.body); res.json(getFunnel()); }));
  app.get('/api/persona', (_, res) => res.json(getPersona()));
  app.put('/api/persona', wrap(async (req, res) => { await savePersona(req.body); res.json(getPersona()); }));

  // ---------- Fans (CRM) ----------
  app.get('/api/fans', wrap(async (_, res) => res.json(await listFans())));
  app.get('/api/fans/:id/messages', wrap(async (req, res) => res.json(await fanMessages(req.params.id))));
  app.patch('/api/fans/:id', wrap(async (req, res) => {
    const { status, step_id } = req.body || {};
    const f = getFunnel();
    const fields = {};
    if (status !== undefined) {
      if (!['active', 'paused', 'stopped'].includes(status)) throw new Error('Statut invalide');
      fields.status = status;
    }
    if (step_id !== undefined) {
      if (step_id === '__phase1') Object.assign(fields, { phase: 1, phase1_count: 0, step_id: null, step_msgs: 0, step_done: false });
      else if (f.steps[step_id]) Object.assign(fields, { phase: 2, step_id, step_msgs: 0, step_done: false });
      else throw new Error(`Étape "${step_id}" introuvable`);
    }
    // Réactiver un fan bloqué sur une étape "stop" : on le sort de cette étape
    if (fields.status === 'active' && fields.step_id === undefined) {
      const { data: cur } = await sb.from('fans').select('step_id').eq('id', req.params.id).maybeSingle();
      if (cur && f.steps[cur.step_id]?.type === 'stop') {
        const back = Object.entries(f.steps).find(([, st]) => st.type === 'end')?.[0] || f.start;
        Object.assign(fields, { step_id: back, step_msgs: 0, step_done: false });
      }
    }
    res.json(await adminUpdateFan(req.params.id, fields));
  }));
  app.delete('/api/fans/:id', wrap(async (req, res) => { await resetFan(req.params.id); res.json({ ok: true }); }));

  // ---------- Stats ----------
  app.get('/api/stats', wrap(async (_, res) => res.json(await stats())));

  return app;
}
