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
  /** … dont déjà une réponse */
  pendingReplied: number;
  /** Taux provisoire : réponses à ce jour / tous les fans du groupe (48 h finies ou non), null si aucun */
  soFar: number | null;
  /** Taux de réponse sur les fans « done » (0–1), null si aucun */
  rate: number | null;
  /** Réponses rapides parmi les « done » */
  within1h: number;
  within24h: number;
  /** Délai médian avant la 1re réponse (minutes), null si aucune */
  medianMin: number | null;
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
  /** Confiance que l'écart est réel (0–1), null sans données */
  confidence: number | null;
  /** Écart en points (voice − none) et multiplicateur, null sans données */
  diffPts: number | null;
  ratio: number | null;
  /** Fans encore nécessaires par groupe (estimation) avant un verdict */
  needPerGroup: number;
  /** Tous fans confondus (test ou pas) : terminés / ont répondu */
  all: { done: number; replied: number; rate: number | null; total: number; repliedSoFar: number; soFar: number | null };
}

const empty = (): AbGroupStats => ({ done: 0, replied: 0, pending: 0, pendingReplied: 0, soFar: null, rate: null, within1h: 0, within24h: 0, medianMin: null });

/** Fonction d'erreur (approximation d'Abramowitz-Stegun), pour la p-value du test z */
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const a = [...xs].sort((p, q) => p - q);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export function computeStats(entries: AbEntry[], now = Date.now()): AbStats {
  const voice = empty();
  const none = empty();
  const delays = { voice: [] as number[], none: [] as number[] };
  const all = { done: 0, replied: 0, rate: null as number | null, total: 0, repliedSoFar: 0, soFar: null as number | null };
  let excluded = 0;
  let since: number | null = null;
  for (const e of entries) {
    since = since === null ? e.at : Math.min(since, e.at);
    const finished = now - e.at >= AB_WINDOW_MS;
    all.total++;
    if (e.r) all.repliedSoFar++;
    if (finished) {
      all.done++;
      if (e.r) all.replied++;
    }
    if (e.g === "voice" && !e.s) {
      excluded++;
      continue;
    }
    const g = e.g === "voice" ? voice : none;
    if (!finished) {
      g.pending++;
      if (e.r) g.pendingReplied++;
      continue;
    }
    g.done++;
    if (e.r) {
      g.replied++;
      const d = e.r - e.at;
      if (d <= 3600_000) g.within1h++;
      if (d <= 24 * 3600_000) g.within24h++;
      delays[e.g].push(d / 60_000);
    }
  }
  for (const g of [voice, none]) {
    g.rate = g.done ? g.replied / g.done : null;
    const total = g.done + g.pending;
    g.soFar = total ? (g.replied + g.pendingReplied) / total : null;
  }
  all.rate = all.done ? all.replied / all.done : null;
  all.soFar = all.total ? all.repliedSoFar / all.total : null;
  voice.medianMin = median(delays.voice);
  none.medianMin = median(delays.none);
  // Test z sur deux proportions, seuil 95 % ; verdict seulement avec au moins 30 fans finis par groupe
  let significant: boolean | null = null;
  let confidence: number | null = null;
  let diffPts: number | null = null;
  let ratio: number | null = null;
  if (voice.done && none.done) {
    diffPts = (voice.rate! - none.rate!) * 100;
    ratio = none.rate! > 0 ? voice.rate! / none.rate! : null;
    const p = (voice.replied + none.replied) / (voice.done + none.done);
    const se = Math.sqrt(p * (1 - p) * (1 / voice.done + 1 / none.done));
    const z = se > 0 ? Math.abs(voice.rate! - none.rate!) / se : 0;
    confidence = erf(z / Math.SQRT2); // = 1 − p-value (bilatérale)
    if (voice.done >= 30 && none.done >= 30) significant = z >= 1.96;
  }
  // Taille utile par groupe pour détecter l'écart observé (α 5 %, puissance 80 %), sinon 30
  let needPerGroup = 30;
  if (diffPts !== null && Math.abs(diffPts) >= 1) {
    const p1 = voice.rate!, p2 = none.rate!, d = Math.abs(p1 - p2);
    const n = Math.ceil(((1.96 + 0.84) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2))) / (d * d));
    needPerGroup = Math.max(30, n);
  }
  needPerGroup = Math.max(0, needPerGroup - Math.min(voice.done, none.done));
  return { voice, none, excluded, since: since === null ? null : new Date(since).toISOString(), significant, confidence, diffPts, ratio, needPerGroup, all };
}

export async function abStats(accountId: string): Promise<AbStats> {
  const all = (await getRedis().hgetall<Record<string, string | AbEntry>>(key(accountId))) ?? {};
  return computeStats(Object.values(all).map((v) => parse(v)!));
}

/** Remise à zéro du test (nouveau départ) */
export async function abReset(accountId: string): Promise<void> {
  await getRedis().del(key(accountId));
}
