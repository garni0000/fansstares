import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URL et SUPABASE_SERVICE_KEY manquent dans le .env');
  process.exit(1);
}

// Vérifie qu'on utilise bien la clé secrète (service_role), pas la clé publique (anon)
function keyRole(key) {
  if (key.startsWith('sb_secret_')) return 'service_role';
  if (key.startsWith('sb_publishable_')) return 'anon';
  try { return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role; } catch { return 'inconnu'; }
}
const role = keyRole(process.env.SUPABASE_SERVICE_KEY.trim());
if (role !== 'service_role') {
  console.error(`❌ SUPABASE_SERVICE_KEY est la clé "${role}". Il faut la clé secrète : Supabase > Project Settings > API Keys > "service_role" (ou "secret", commence par sb_secret_).`);
  process.exit(1);
}

export const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY.trim(), {
  auth: { persistSession: false },
});

export const BUCKET = 'galerie';

// Lève une erreur lisible si Supabase renvoie une erreur
export function check({ data, error }, ctx = '') {
  if (error) throw new Error(`Supabase ${ctx}: ${error.message}`);
  return data;
}
