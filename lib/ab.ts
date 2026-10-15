// Test A/B du vocal de bienvenue (Sienna) : un nouvel abonné sur deux reçoit
// le vocal, l'autre rien (les chatters font leur accueil habituel pour tous).
// On compte ensuite qui a ÉCRIT dans les 72 h (webhook « messages.received »).
// Tout est dans un hash Redis par compte : fanId → { g, at, s, r }.
import { createHash } from "node:crypto";
import { getRedis } from "./redis.js";

/** voice = vocal seul · none = rien · selfie = vocal + selfie « prénom au feutre » (Teva, 08/10 : 33/33/33) */
export type AbGroup = "voice" | "none" | "selfie";
/** Fenêtre pendant laquelle une réponse du fan compte */
export const AB_WINDOW_MS = 72 * 3600 * 1000; // 72 h → 72 h le 09/10 (Teva)

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
  /** Chiffre d'affaires du fan dans la fenêtre (tips + achats, montant brut) et nombre d'achats */
  rev?: number;
  /** LTV : tout ce que le fan a dépensé depuis son abonnement (sans limite de temps, hors abonnement) */
  ltv?: number;
  buys?: number;
}

/**
 * Tests successifs, chacun dans son propre hash (les stats d'un test ne touchent jamais l'autre) :
 *   abc = 08/10 → : ⅓ vocal seul, ⅓ rien, ⅓ selfie seul
 *   v90 = 2e test (Teva, 14/10) : 9 fans sur 10 reçoivent le vocal, 1 sur 10 rien
 */
export type AbTest = "abc" | "v90";
export const AB_TESTS: AbTest[] = ["abc", "v90"];
const key = (accountId: string, test: AbTest = "abc") => (test === "abc" ? `welcome:ab:${accountId}` : `welcome:ab:${accountId}:${test}`);

function parse(raw: unknown): AbEntry | null {
  if (raw == null) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as AbEntry;
}

/** 50/50, toujours le même groupe pour un même fan (webhook renvoyé, renvoi…) */
export function groupFor(fanId: string, test: AbTest = "abc"): AbGroup {
  const h = createHash("sha1").update(`welcome-ab:${fanId}`).digest();
  if (test === "v90") return h.readUInt16BE(0) % 10 === 0 ? "none" : "voice";
  return (["voice", "none", "selfie"] as const)[h[0] % 3];
}

/** Inscrit le fan dans le test (s'il n'y est pas déjà) et renvoie son groupe */
export async function enroll(accountId: string, fanId: string, subscribedAt: number, pseudo: string, test: AbTest = "abc"): Promise<AbGroup> {
  const r = getRedis();
  // Un fan déjà dans un test garde son groupe (réabonnement, renvoi) : on ne le remet pas dans un autre
  for (const t of AB_TESTS) {
    const cur = parse(await r.hget(key(accountId, t), fanId));
    if (cur) return cur.g;
  }
  const entry: AbEntry = { g: groupFor(fanId, test), at: subscribedAt, n: pseudo.slice(0, 60) };
  await r.hset(key(accountId, test), { [fanId]: JSON.stringify(entry) });
  return entry.g;
}

/** Le vocal est parti : le fan compte dans le groupe « avec vocal » */
export async function markSent(accountId: string, fanId: string): Promise<void> {
  const r = getRedis();
  for (const t of AB_TESTS) {
    const cur = parse(await r.hget(key(accountId, t), fanId));
    if (!cur) continue;
    // Renvoi manuel à un fan « sans vocal » : il change de groupe (sinon le test serait faux)
    await r.hset(key(accountId, t), { [fanId]: JSON.stringify({ ...cur, g: cur.g === "none" ? "voice" : cur.g, s: true }) });
  }
}

/** Le fan a écrit : on note sa première réponse si elle est dans les 72 h */
export async function recordReply(accountId: string, fanId: string, at = Date.now()): Promise<boolean> {
  let any = false;
  for (const t of AB_TESTS) if (await recordReplyIn(accountId, fanId, at, t)) any = true;
  return any;
}
async function recordReplyIn(accountId: string, fanId: string, at: number, test: AbTest): Promise<boolean> {
  const r = getRedis();
  const cur = parse(await r.hget(key(accountId, test), fanId));
  if (!cur || cur.r || at < cur.at || at - cur.at > AB_WINDOW_MS) return false;
  await r.hset(key(accountId, test), { [fanId]: JSON.stringify({ ...cur, r: at }) });
  return true;
}

/** Le fan a payé (tip, PPV…) : ajouté à son CA si dans la fenêtre */
export async function recordRevenue(accountId: string, fanId: string, amount: number, at = Date.now()): Promise<boolean> {
  if (!(amount > 0)) return false;
  let any = false;
  for (const t of AB_TESTS) if (await recordRevenueIn(accountId, fanId, amount, at, t)) any = true;
  return any;
}
async function recordRevenueIn(accountId: string, fanId: string, amount: number, at: number, test: AbTest): Promise<boolean> {
  const r = getRedis();
  const cur = parse(await r.hget(key(accountId, test), fanId));
  if (!cur || at < cur.at) return false;
  const ltv = Math.round(((cur.ltv ?? cur.rev ?? 0) + amount) * 100) / 100;
  const inWindow = at - cur.at <= AB_WINDOW_MS;
  const next = inWindow ? { ...cur, ltv, rev: Math.round(((cur.rev ?? 0) + amount) * 100) / 100, buys: (cur.buys ?? 0) + 1 } : { ...cur, ltv };
  await r.hset(key(accountId, test), { [fanId]: JSON.stringify(next) });
  return true;
}

/**
 * Rattrapage du CA (rétroactif) : pour une tranche de fans du test, lit leur dépense sur OF et
 * la stocke comme CA (remplace la somme des webhooks : le total OF les inclut déjà).
 */
export async function backfillRevenue(accountId: string, offset: number, limit: number, spend: (fanId: string) => Promise<number | null>, test: AbTest = "abc"): Promise<{ done: number; total: number; next: number | null; errors: number }> {
  const r = getRedis();
  const all = (await r.hgetall<Record<string, string | AbEntry>>(key(accountId, test))) ?? {};
  const ids = Object.keys(all).sort();
  const slice = ids.slice(offset, offset + limit);
  let errors = 0;
  for (const id of slice) {
    try {
      const v = await spend(id);
      if (v == null) { errors++; continue; }
      const cur = parse(await r.hget(key(accountId, test), id));
      if (!cur) continue;
      // le total OF = LTV ; c'est aussi le CA 72 h tant que le fan est dans sa fenêtre
      const inWindow = Date.now() - cur.at <= AB_WINDOW_MS;
      const upd = inWindow ? { ...cur, ltv: v, rev: v, buys: v > 0 ? Math.max(1, cur.buys ?? 0) : 0, bf: 1 } : { ...cur, ltv: v, bf: 1 };
      await r.hset(key(accountId, test), { [id]: JSON.stringify(upd) });
    } catch { errors++; }
  }
  const next = offset + slice.length < ids.length ? offset + slice.length : null;
  return { done: offset + slice.length, total: ids.length, next, errors };
}

export interface AbGroupStats {
  /** Fans dont la fenêtre de 72 h est terminée (seuls eux comptent) */
  done: number;
  replied: number;
  /** Encore dans les 72 h */
  pending: number;
  /** … dont déjà une réponse */
  pendingReplied: number;
  /** Taux provisoire : réponses à ce jour / tous les fans du groupe (72 h finies ou non), null si aucun */
  soFar: number | null;
  /** Taux de réponse sur les fans « done » (0–1), null si aucun */
  rate: number | null;
  /** Réponses rapides parmi les « done » */
  within1h: number;
  within24h: number;
  /** Délai médian avant la 1re réponse (minutes), null si aucune */
  medianMin: number | null;
  /** CA dans la fenêtre : total, nombre de fans ayant payé, CA moyen par fan du groupe (tous fans) */
  revenue: number;
  buyers: number;
  revPerFan: number | null;
  /** LTV : somme et moyenne par fan du groupe (depuis l'abonnement, sans limite de temps) */
  ltv: number;
  ltvPerFan: number | null;
}

export interface AbStats {
  voice: AbGroupStats;
  none: AbGroupStats;
  selfie: AbGroupStats;
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
  /** Reply rate par jour d'abonnement et par groupe : { "2026-10-08": { voice: {n, r}, … } } */
  daily: Record<string, Record<AbGroup, { n: number; r: number }>>;
}

const empty = (): AbGroupStats => ({ done: 0, replied: 0, pending: 0, pendingReplied: 0, soFar: null, rate: null, within1h: 0, within24h: 0, medianMin: null, revenue: 0, buyers: 0, revPerFan: null, ltv: 0, ltvPerFan: null });

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
  const selfie = empty();
  const delays = { voice: [] as number[], none: [] as number[], selfie: [] as number[] };
  const daily: Record<string, Record<AbGroup, { n: number; r: number }>> = {};
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
    if (e.g !== "none" && !e.s) {
      excluded++;
      continue;
    }
    const g = e.g === "voice" ? voice : e.g === "selfie" ? selfie : none;
    if (e.rev) { g.revenue = Math.round((g.revenue + e.rev) * 100) / 100; g.buyers++; }
    const lv = e.ltv ?? e.rev ?? 0;
    if (lv) g.ltv = Math.round((g.ltv + lv) * 100) / 100;
    // Courbe : reply rate par jour d'abonnement (cohortes)
    const day = new Date(e.at).toISOString().slice(0, 10);
    const dd = (daily[day] ??= { voice: { n: 0, r: 0 }, none: { n: 0, r: 0 }, selfie: { n: 0, r: 0 } });
    dd[e.g].n++;
    if (e.r) dd[e.g].r++;
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
  for (const g of [voice, none, selfie]) {
    g.rate = g.done ? g.replied / g.done : null;
    const total = g.done + g.pending;
    g.soFar = total ? (g.replied + g.pendingReplied) / total : null;
    g.revPerFan = total ? Math.round((g.revenue / total) * 100) / 100 : null;
    g.ltvPerFan = total ? Math.round((g.ltv / total) * 100) / 100 : null;
  }
  all.rate = all.done ? all.replied / all.done : null;
  all.soFar = all.total ? all.repliedSoFar / all.total : null;
  voice.medianMin = median(delays.voice);
  none.medianMin = median(delays.none);
  selfie.medianMin = median(delays.selfie);
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
  return { daily, voice, none, selfie, excluded, since: since === null ? null : new Date(since).toISOString(), significant, confidence, diffPts, ratio, needPerGroup, all };
}

export async function abStats(accountId: string, test: AbTest = "abc"): Promise<AbStats> {
  const all = (await getRedis().hgetall<Record<string, string | AbEntry>>(key(accountId, test))) ?? {};
  return computeStats(Object.values(all).map((v) => parse(v)!));
}

/** Remise à zéro du test (nouveau départ) */
export async function abReset(accountId: string, test: AbTest = "abc"): Promise<void> {
  await getRedis().del(key(accountId, test));
}
