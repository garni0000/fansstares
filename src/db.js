// Accès base Supabase : fans, messages, ventes
import { sb, check } from './supabase.js';

const now = () => new Date().toISOString();

export async function getFan(user) {
  const found = check(await sb.from('fans').select('*').eq('id', user.id).maybeSingle(), 'getFan');
  if (found) return found;
  return check(
    await sb.from('fans')
      .insert({ id: user.id, first_name: user.first_name || '', username: user.username || '' })
      .select().single(),
    'createFan',
  );
}

export async function updateFan(id, fields) {
  check(await sb.from('fans').update({ ...fields, last_seen: now() }).eq('id', id), 'updateFan');
}

export async function resetFan(id) {
  check(await sb.from('fans').delete().eq('id', id), 'resetFan'); // cascade messages + sales
}

export async function addMessage(fanId, role, content) {
  check(await sb.from('messages').insert({ fan_id: fanId, role, content }), 'addMessage');
}

export async function getHistory(fanId, limit = 30) {
  const rows = check(
    await sb.from('messages').select('role, content').eq('fan_id', fanId)
      .order('id', { ascending: false }).limit(limit),
    'getHistory',
  );
  return rows.reverse();
}

export async function logSale(fanId, stepId, stars, status) {
  check(await sb.from('sales').insert({ fan_id: fanId, step_id: stepId, stars, status }), 'logSale');
}

const rowsOf = async (q) => check(await q, 'rows') ?? [];

export async function stats() {
  const c = (table, f) => {
    let q = sb.from(table).select('*', { count: 'exact', head: true });
    if (f) q = f(q);
    return q.then((r) => { if (r.error) throw r.error; return r.count ?? 0; });
  };
  const [fans, phase2, ppvSent, ppvPaid, paidRows] = await Promise.all([
    c('fans'),
    c('fans', (q) => q.eq('phase', 2)),
    c('sales', (q) => q.eq('status', 'sent')),
    c('sales', (q) => q.eq('status', 'paid')),
    rowsOf(sb.from('sales').select('stars').eq('status', 'paid')),
  ]);
  const stars = (paidRows || []).reduce((s, r) => s + (r.stars || 0), 0);
  return { fans, phase2, ppvSent, ppvPaid, stars };
}

// Nombre d'envois d'un PPV à un fan (envoi + renvois)
export async function countSends(fanId, stepId) {
  const { count, error } = await sb.from('sales').select('*', { count: 'exact', head: true })
    .eq('fan_id', fanId).eq('step_id', stepId).in('status', ['sent', 'resent']);
  if (error) throw new Error('countSends: ' + error.message);
  return count ?? 0;
}

// ---------- CRM ----------
export async function listFans() {
  return check(await sb.from('fans').select('*').order('last_seen', { ascending: false }).limit(1000), 'listFans');
}

export async function fanMessages(fanId, limit = 300) {
  const rows = check(
    await sb.from('messages').select('role, content, created_at').eq('fan_id', fanId)
      .order('id', { ascending: false }).limit(limit),
    'fanMessages',
  );
  return rows.reverse();
}

// Modification depuis le panneau (ne touche pas à last_seen)
export async function adminUpdateFan(id, fields) {
  return check(await sb.from('fans').update(fields).eq('id', id).select().single(), 'adminUpdateFan');
}
