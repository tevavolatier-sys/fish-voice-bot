// Test A/B du vocal de bienvenue (Sienna) : un nouvel abonné sur deux reçoit
// le vocal, l'autre rien (les chatters font leur accueil habituel pour tous).
// On compte ensuite qui a ÉCRIT dans les 48 h (webhook « messages.received »).
// Tout est dans un hash Redis par compte : fanId → { g, at, s, r }.
import { createHash } from "node:crypto";
import { getRedis } from "./redis.js";

export type AbGroup = "voice" | "none";
/** Fenêtre pendant laquelle une réponse du fan compte */
export const AB_WINDOW_MS = 48 * 3600 * 1000;

interface AbEntry {
  g: AbGroup;
  /** Abonnement (ms) */
  at: number;
  /** Vocal réellement envoyé (groupe voice seulement) */
  s?: boolean;
  /** Première réponse du fan (ms), si dans la fenêtre */
  r?: number;
  /** Pseudo, pour le journal */
  n?: string;
}

const key = (accountId: string) => `welcome:ab:${accountId}`;

function parse(raw: unknown): AbEntry | null {
  if (raw == null) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as AbEntry;
}

/** 50/50, toujours le même groupe pour un même fan (webhook renvoyé, renvoi…) */
export function groupFor(fanId: string): AbGroup {
  const h = createHash("sha1").update(`welcome-ab:${fanId}`).digest();
  return h[0] % 2 === 0 ? "voice" : "none";
}

/** Inscrit le fan dans le test (s'il n'y est pas déjà) et renvoie son groupe */
export async function enroll(accountId: string, fanId: string, subscribedAt: number, pseudo: string): Promise<AbGroup> {
  const r = getRedis();
  const cur = parse(await r.hget(key(accountId), fanId));
  if (cur) return cur.g;
  const entry: AbEntry = { g: groupFor(fanId), at: subscribedAt, n: pseudo.slice(0, 60) };
  await r.hset(key(accountId), { [fanId]: JSON.stringify(entry) });
  return entry.g;
}

/** Le vocal est parti : le fan compte dans le groupe « avec vocal » */
export async function markSent(accountId: string, fanId: string): Promise<void> {
  const r = getRedis();
  const cur = parse(await r.hget(key(accountId), fanId));
  if (!cur) return;
  // Renvoi manuel à un fan « sans vocal » : il change de groupe (sinon le test serait faux)
  await r.hset(key(accountId), { [fanId]: JSON.stringify({ ...cur, g: "voice", s: true }) });
}

/** Le fan a écrit : on note sa première réponse si elle est dans les 48 h */
export async function recordReply(accountId: string, fanId: string, at = Date.now()): Promise<boolean> {
  const r = getRedis();
  const cur = parse(await r.hget(key(accountId), fanId));
  if (!cur || cur.r || at < cur.at || at - cur.at > AB_WINDOW_MS) return false;
  await r.hset(key(accountId), { [fanId]: JSON.stringify({ ...cur, r: at }) });
  return true;
}

export interface AbGroupStats {
  /** Fans dont la fenêtre de 48 h est terminée (seuls eux comptent) */
  done: number;
  replied: number;
  /** Encore dans les 48 h */
  pending: number;
  /** Taux de réponse sur les fans « done » (0–1), null si aucun */
  rate: number | null;
}

export interface AbStats {
  voice: AbGroupStats;
  none: AbGroupStats;
  /** Groupe voice sans vocal parti (trop tard, échec) : hors test */
  excluded: number;
  /** Premier fan inscrit (ISO), null si aucun */
  since: string | null;
  /** Écart significatif (test z à 95 %) ; null tant qu'il n'y a pas assez de fans */
  significant: boolean | null;
}

const empty = (): AbGroupStats => ({ done: 0, replied: 0, pending: 0, rate: null });

export function computeStats(entries: AbEntry[], now = Date.now()): AbStats {
  const voice = empty();
  const none = empty();
  let excluded = 0;
  let since: number | null = null;
  for (const e of entries) {
    since = since === null ? e.at : Math.min(since, e.at);
    if (e.g === "voice" && !e.s) {
      excluded++;
      continue;
    }
    const g = e.g === "voice" ? voice : none;
    if (now - e.at < AB_WINDOW_MS) {
      g.pending++;
      continue;
    }
    g.done++;
    if (e.r) g.replied++;
  }
  for (const g of [voice, none]) g.rate = g.done ? g.replied / g.done : null;
  // Test z sur deux proportions, seuil 95 % ; demande au moins 30 fans finis par groupe
  let significant: boolean | null = null;
  if (voice.done >= 30 && none.done >= 30) {
    const p = (voice.replied + none.replied) / (voice.done + none.done);
    const se = Math.sqrt(p * (1 - p) * (1 / voice.done + 1 / none.done));
    const z = se > 0 ? Math.abs(voice.rate! - none.rate!) / se : 0;
    significant = z >= 1.96;
  }
  return { voice, none, excluded, since: since === null ? null : new Date(since).toISOString(), significant };
}

export async function abStats(accountId: string): Promise<AbStats> {
  const all = (await getRedis().hgetall<Record<string, string | AbEntry>>(key(accountId))) ?? {};
  return computeStats(Object.values(all).map((v) => parse(v)!));
}

/** Remise à zéro du test (nouveau départ) */
export async function abReset(accountId: string): Promise<void> {
  await getRedis().del(key(accountId));
}
