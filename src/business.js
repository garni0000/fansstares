// Telegram Business : le bot répond depuis le compte perso (Premium) auquel il est connecté.
// On retient, pour chaque fan, s'il écrit au compte perso (business) ou directement au bot.
import { getSetting, saveSettings } from './config.js';

const routes = new Map(); // fanId -> business_connection_id

export const routeOf = (chatId) => routes.get(Number(chatId));
export function setRoute(fanId, connId) {
  if (connId) routes.set(Number(fanId), connId);
  else routes.delete(Number(fanId));
}

// Infos de la connexion (stockées dans Supabase > settings, clé BUSINESS_INFO)
export function businessInfo() {
  try { return JSON.parse(getSetting('BUSINESS_INFO') || 'null'); } catch { return null; }
}

export async function saveBusinessInfo(conn) {
  const info = conn && {
    id: conn.id,
    ownerId: conn.user?.id,
    ownerName: [conn.user?.first_name, conn.user?.last_name].filter(Boolean).join(' '),
    ownerUsername: conn.user?.username || '',
    canReply: conn.rights ? !!conn.rights.can_reply : !!conn.can_reply,
    enabled: conn.is_enabled !== false,
    date: conn.date,
  };
  await saveSettings({ BUSINESS_INFO: JSON.stringify(info || { enabled: false }) });
  return info;
}

// Connexion à utiliser si on ne connaît pas encore la route d'un fan (ex : après redémarrage)
export function defaultConnId() {
  const i = businessInfo();
  return i?.enabled ? i.id : null;
}
