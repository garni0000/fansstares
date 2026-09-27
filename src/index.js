import 'dotenv/config';
import { loadSettings } from './config.js';
import { loadDocs } from './store.js';
import { ensureBucket, syncFolder, watchFolder } from './gallery.js';
import { startBot } from './bot.js';
import { createServer } from './server.js';

if (!process.env.ADMIN_PASSWORD) {
  console.error('❌ ADMIN_PASSWORD manquant dans le .env');
  process.exit(1);
}

await loadSettings();
await loadDocs();
await ensureBucket();

// Dossier ./galerie -> Supabase au démarrage, puis surveillance
const r = await syncFolder().catch((e) => ({ errors: [e.message], added: [], updated: [] }));
console.log(`🖼️  Galerie : ${r.added.length} ajouté(s), ${r.updated.length} mis à jour`);
if (r.errors.length) console.error('Galerie :', r.errors.join(' | '));
watchFolder();

const port = Number(process.env.PORT) || 3000;
createServer().listen(port, () => console.log(`🛠️  Panneau admin : http://localhost:${port}`));

const s = await startBot();
if (!s.running) console.log(`⚠️  Bot non démarré : ${s.error} — règle-le dans le panneau admin`);
