// Suivi des PPV perso (demande de Teva, 15/10/2026) : pour chaque fan dont le bot a fabriqué
// les vidéos, on note si le chatter a ENVOYÉ le PPV contenant SON PPV 1 (webhook messages.sent :
// un message payant qui contient l'id de la vidéo du vault) puis si le fan l'a ACHETÉ
// (webhook messages.ppv.unlocked sur ce message). Unlock rate = achetés / envoyés.
import { getRedis } from "./redis.js";

export interface TrackEntry {
  at: number; // fabrication (ms)
  name: string;
  ids: string[]; // ids des vidéos du vault (preview, PPV 1)
  sentAt?: number;
  msgIds?: string[]; // messages payants qui contiennent nos vidéos
  price?: number;
  boughtAt?: number;
  amount?: number;
}

const KEY = (acct: string) => `ppvtrack:${acct}`;
const parse = (raw: unknown): TrackEntry | null => (raw == null ? null : typeof raw === "string" ? (JSON.parse(raw) as TrackEntry) : (raw as TrackEntry));

export async function trackMade(acct: string, fanId: string, name: string, ids: string[]): Promise<void> {
  const prev = parse(await getRedis().hget(KEY(acct), fanId));
  // Une nouvelle fabrication (Redo) remplace les vidéos suivies mais garde un envoi/achat déjà vu
  const e: TrackEntry = { ...(prev ?? {}), at: Date.now(), name, ids: [...new Set([...(prev?.boughtAt ? [] : prev?.ids ?? []), ...ids])] };
  await getRedis().hset(KEY(acct), { [fanId]: JSON.stringify(e) });
}

/** Webhook messages.sent : le message payant contient-il une de nos vidéos ? */
export async function trackSent(acct: string, fanId: string, messageId: string, mediaIds: string[], price: number): Promise<boolean> {
  if (!fanId || !(price > 0) || !mediaIds.length) return false;
  const e = parse(await getRedis().hget(KEY(acct), fanId));
  if (!e || !mediaIds.some((m) => e.ids.includes(m))) return false;
  e.sentAt ??= Date.now();
  e.price = price;
  e.msgIds = [...new Set([...(e.msgIds ?? []), messageId].filter(Boolean))];
  await getRedis().hset(KEY(acct), { [fanId]: JSON.stringify(e) });
  return true;
}

/** Webhook messages.ppv.unlocked : achat d'un message qu'on suit (par id du message ou par ses médias) */
export async function trackBought(acct: string, fanId: string, messageId: string, amount: number, mediaIds: string[] = []): Promise<boolean> {
  const e = parse(await getRedis().hget(KEY(acct), fanId));
  if (!e || e.boughtAt) return false;
  const match = (messageId && e.msgIds?.includes(messageId)) || mediaIds.some((m) => e.ids.includes(m));
  if (!match) return false;
  e.boughtAt = Date.now();
  e.amount = amount;
  e.sentAt ??= e.boughtAt; // envoyé forcément (webhook d'envoi manqué)
  await getRedis().hset(KEY(acct), { [fanId]: JSON.stringify(e) });
  return true;
}

/** Le fan a-t-il des vidéos perso suivies ? (évite une requête OF inutile) */
export async function isTracked(acct: string, fanId: string): Promise<boolean> {
  return (await getRedis().hexists(KEY(acct), fanId)) === 1;
}

export interface TrackStats { made: number; sent: number; bought: number; revenue: number; rate: number | null }

/** Stats sur les PPV fabriqués depuis `since` (ms). Les entrées de plus de 45 jours sont supprimées. */
export async function trackStats(acct: string, since: number): Promise<TrackStats> {
  const all = (await getRedis().hgetall<Record<string, string | TrackEntry>>(KEY(acct))) ?? {};
  const old: string[] = [];
  const s: TrackStats = { made: 0, sent: 0, bought: 0, revenue: 0, rate: null };
  for (const [fan, raw] of Object.entries(all)) {
    const e = parse(raw);
    if (!e) continue;
    if (e.at < Date.now() - 45 * 24 * 3600_000) { old.push(fan); continue; }
    if (e.at < since) continue;
    s.made++;
    if (e.sentAt) s.sent++;
    if (e.boughtAt) { s.bought++; s.revenue += e.amount ?? 0; }
  }
  if (old.length) await getRedis().hdel(KEY(acct), ...old);
  s.rate = s.sent ? s.bought / s.sent : null;
  s.revenue = Math.round(s.revenue * 100) / 100;
  return s;
}
