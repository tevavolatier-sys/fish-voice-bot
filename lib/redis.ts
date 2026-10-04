import { Redis } from "@upstash/redis";

// L'intégration Upstash du Marketplace Vercel injecte UPSTASH_REDIS_REST_*.
// Certaines versions de l'intégration utilisent le préfixe KV_* : on accepte les deux.
// Initialisation paresseuse pour que la fonction démarre même si les variables
// manquent (l'erreur claire est renvoyée au moment de l'utilisation).
let client: Redis | null = null;

function getRedis(): Redis {
  if (client) return client;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Variables Upstash Redis manquantes (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)"
    );
  }
  client = new Redis({ url, token });
  return client;
}

export function hasRedisEnv(): boolean {
  return Boolean(
    (process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL) &&
      (process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN)
  );
}

const STATS_KEYS = [
  "stats:gen:model",
  "stats:chars:model",
  "stats:gen:user",
  "stats:chars:user",
] as const;

/** Modèle actuellement sélectionnée par un opérateur */
export async function getSelectedModel(userId: number): Promise<string | null> {
  return getRedis().get<string>(`voice:${userId}`);
}

export async function setSelectedModel(
  userId: number,
  modelKey: string
): Promise<void> {
  await getRedis().set(`voice:${userId}`, modelKey);
}

/** Niveau d'intensité (0-3) choisi par un opérateur via /niveau */
export async function getIntensity(userId: number): Promise<number | null> {
  const v = await getRedis().get<number | string>(`intensity:${userId}`);
  return v === null || v === undefined ? null : Number(v);
}

export async function setIntensity(
  userId: number,
  level: number
): Promise<void> {
  await getRedis().set(`intensity:${userId}`, level);
}

/**
 * Dernier texte envoyé par un opérateur (30 min) : permet le bouton
 * « 🔁 Try again » quand une génération échoue, sans retaper le texte.
 */
export async function setLastText(userId: number, text: string): Promise<void> {
  await getRedis().set(`lasttext:${userId}`, text, { ex: 1800 });
}

export async function getLastText(userId: number): Promise<string | null> {
  return getRedis().get<string>(`lasttext:${userId}`);
}

/**
 * Alerte crédits bas : au plus une fois par 24 h (verrou NX).
 * Renvoie true si l'alerte peut partir maintenant.
 */
export async function shouldWarnCredits(): Promise<boolean> {
  const ok = await getRedis().set("credit_warned", "1", { nx: true, ex: 86_400 });
  return ok === "OK";
}

/** Alerte « traduction FR en panne » : au plus une fois par heure */
export async function shouldWarnTranslate(): Promise<boolean> {
  const ok = await getRedis().set("translate_warned", "1", { nx: true, ex: 3_600 });
  return ok === "OK";
}

/**
 * 🎬 Source d'une vidéo : le vocal exact (file_id Telegram) derrière le
 * bouton « 🎬 Video ». Gardé 7 jours : on peut faire la vidéo plus tard.
 */
export interface VideoSource {
  f: string; // file_id Telegram du vocal
  m: string; // clé de la modèle
  s?: string; // style (🌙 Soft…)
}

export async function setVideoSource(token: string, src: VideoSource): Promise<void> {
  await getRedis().set(`vidsrc:${token}`, JSON.stringify(src), { ex: 7 * 86_400 });
}

export async function getVideoSource(token: string): Promise<VideoSource | null> {
  const raw = await getRedis().get<string | VideoSource>(`vidsrc:${token}`);
  if (!raw) return null;
  // Upstash désérialise parfois le JSON lui-même
  return typeof raw === "string" ? (JSON.parse(raw) as VideoSource) : raw;
}

/** Anti double-clic sur 🎬 : une seule vidéo en cours par vocal (60 s). */
export async function lockVideo(token: string): Promise<boolean> {
  const ok = await getRedis().set(`vidlock:${token}`, "1", { nx: true, ex: 60 });
  return ok === "OK";
}

export async function unlockVideo(token: string): Promise<void> {
  await getRedis().del(`vidlock:${token}`);
}

/** Compteur de vidéos (par modèle et par opérateur), affiché dans /stats */
export async function recordVideo(userId: number, modelKey: string): Promise<void> {
  const p = getRedis().pipeline();
  p.hincrby("stats:video:model", modelKey, 1);
  p.hincrby("stats:video:user", String(userId), 1);
  await p.exec();
}

export async function readVideoStats(): Promise<{
  byModel: Record<string, number>;
  byUser: Record<string, number>;
}> {
  const redis = getRedis();
  const [byModel, byUser] = await Promise.all([
    redis.hgetall<Record<string, number>>("stats:video:model"),
    redis.hgetall<Record<string, number>>("stats:video:user"),
  ]);
  return { byModel: byModel ?? {}, byUser: byUser ?? {} };
}

// ── 💰 Vidéos PPV (enregistrées par l'admin via /ppvadd) ─────────────────
// Liste Redis (RPUSH atomique : les vidéos d'un album arrivent en même temps)
// + ensemble des identifiants uniques pour ne jamais enregistrer deux fois
// la même vidéo.
export interface PpvPart {
  f: string; // file_id Telegram
  u: string; // file_unique_id
  d: number; // durée (s)
  b: number; // taille (octets)
  m?: number; // message_id d'envoi : fixe l'ordre (vidéo payante 1 puis 2)
}

export async function addPpvPart(model: string, part: PpvPart): Promise<number | null> {
  const redis = getRedis();
  const isNew = await redis.sadd(`ppv:uids:${model}`, part.u);
  if (!isNew) return null; // déjà enregistrée
  return redis.rpush(`ppv:parts:${model}`, JSON.stringify(part));
}

export async function getPpvParts(model: string): Promise<PpvPart[]> {
  const raw = await getRedis().lrange<string | PpvPart>(`ppv:parts:${model}`, 0, -1);
  const parts = raw.map((r) => (typeof r === "string" ? (JSON.parse(r) as PpvPart) : r));
  // Ordre d'ENVOI (les vidéos d'un album peuvent être traitées dans le désordre)
  return parts
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.m ?? a.i) - (b.p.m ?? b.i) || a.i - b.i)
    .map(({ p }) => p);
}

export async function clearPpvParts(model: string): Promise<void> {
  await getRedis().del(`ppv:parts:${model}`, `ppv:uids:${model}`);
}

/** Album envoyé avec la légende /ppvadd : ses autres vidéos suivent sans légende */
export async function armPpvGroup(groupId: string, model: string): Promise<void> {
  await getRedis().set(`ppvgroup:${groupId}`, model, { ex: 300 });
}

export async function ppvGroupModel(groupId: string): Promise<string | null> {
  return getRedis().get<string>(`ppvgroup:${groupId}`);
}

/** Volume de voix PPV choisi par un opérateur (1 à 5) */
export async function getPpvVolume(userId: number): Promise<number | null> {
  const v = await getRedis().get<number | string>(`ppvvol:${userId}`);
  return v === null || v === undefined ? null : Number(v);
}

export async function setPpvVolume(userId: number, level: number): Promise<void> {
  await getRedis().set(`ppvvol:${userId}`, level);
}

/** Effet de voix PPV choisi par un opérateur (clé d'effet, ex. « natural ») */
export async function getPpvEffect(userId: number): Promise<string | null> {
  return getRedis().get<string>(`ppveff:${userId}`);
}

export async function setPpvEffect(userId: number, effect: string): Promise<void> {
  await getRedis().set(`ppveff:${userId}`, effect);
}

// ── 📣 Mass messages PPV ──
export async function getMassRaw(userId: number): Promise<unknown> {
  const raw = await getRedis().get<unknown>(`mass:cfg:${userId}`);
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveMass(userId: number, cfg: object): Promise<void> {
  await getRedis().set(`mass:cfg:${userId}`, JSON.stringify(cfg));
}

/** Texte généré, gardé 24 h pour ⭐ / 🌐 */
export async function saveMassText(id: string, text: string): Promise<void> {
  await getRedis().set(`mass:t:${id}`, text, { ex: 24 * 3600 });
}

export async function getMassText(id: string): Promise<string | null> {
  return getRedis().get<string>(`mass:t:${id}`);
}

/** ⭐ Textes gardés (les 30 derniers, partagés par toute l'équipe) */
export async function addMassFav(text: string): Promise<void> {
  const r = getRedis();
  await r.lpush("mass:fav", text);
  await r.ltrim("mass:fav", 0, 29);
}

export async function getMassFavs(): Promise<string[]> {
  return getRedis().lrange<string>("mass:fav", 0, 29);
}

/** 🎁 Vidéo de la preview gratuite (sinon : fond noir) */
export async function getPpvPreview(model: string): Promise<PpvPart | null> {
  const raw = await getRedis().get<string | PpvPart>(`ppv:preview:${model}`);
  if (!raw) return null;
  return typeof raw === "string" ? (JSON.parse(raw) as PpvPart) : raw;
}

export async function setPpvPreview(model: string, part: PpvPart): Promise<void> {
  await getRedis().set(`ppv:preview:${model}`, JSON.stringify(part));
}

/** ⚙️ Réglages PPV (JSON complet, validé à la lecture par normalizeSettings) */
export async function getPpvSettingsRaw(): Promise<unknown> {
  const raw = await getRedis().get<unknown>("ppvcfg");
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function savePpvSettings(settings: object): Promise<void> {
  await getRedis().set("ppvcfg", JSON.stringify(settings));
}

/** Prises proposées (🎲) en attente d'un ✅, gardées 6 h */
export interface FixedCandidate {
  line: string;
  model: string;
  a: string; // MP3 en base64
  t: string; // texte de la prise
}

export async function saveFixedCandidate(id: string, c: FixedCandidate): Promise<void> {
  await getRedis().set(`ppvcand:${id}`, JSON.stringify(c), { ex: 6 * 3600 });
}

export async function getFixedCandidate(id: string): Promise<FixedCandidate | null> {
  const raw = await getRedis().get<string | FixedCandidate>(`ppvcand:${id}`);
  if (!raw) return null;
  return typeof raw === "string" ? (JSON.parse(raw) as FixedCandidate) : raw;
}

/**
 * Un PPV déjà généré, gardé 6 h pour pouvoir le REFAIRE à un autre volume ou
 * avec un autre effet, avec la MÊME voix (sans repasser par Fish Audio).
 */
export interface PpvJob {
  name: string;
  v1: string; // voix PPV 1 (WAV en base64)
  f1?: string; // partie fixe seule (base64) : le gain est calé dessus
  p1: string; // file_id de la vidéo PPV 1
  r1?: number; // ancien format : niveau de la partie fixe avec l'effet iPhone
  s1?: number; // début (s) de la phrase 1 dans la vidéo (partie fixe à instant constant)
  lvl?: number; // dernier volume envoyé
  fx?: string; // dernier effet envoyé
}

export async function savePpvJob(token: string, job: PpvJob): Promise<void> {
  await getRedis().set(`ppvjob:${token}`, JSON.stringify(job), { ex: 6 * 3600 });
}

export async function getPpvJob(token: string): Promise<PpvJob | null> {
  const raw = await getRedis().get<string | PpvJob>(`ppvjob:${token}`);
  if (!raw) return null;
  return typeof raw === "string" ? (JSON.parse(raw) as PpvJob) : raw;
}

/**
 * Partie FIXE d'une phrase PPV (la même pour tous les fans) :
 *   tts    → prise générée une fois par Fish (MP3 en base64)
 *   upload → vrai enregistrement envoyé par l'admin (file_id Telegram)
 * `t` : texte d'où vient une prise tts — s'il change, la prise est refaite.
 */
export type PpvFixed =
  | { src: "tts"; a: string; at: string; t?: string }
  | { src: "upload"; f: string; kind: "voice" | "audio"; at: string; t?: string };

export async function getPpvFixed(model: string, line: string): Promise<PpvFixed | null> {
  const raw = await getRedis().get<string | PpvFixed>(`ppvfix:${model}:${line}`);
  if (!raw) return null;
  return typeof raw === "string" ? (JSON.parse(raw) as PpvFixed) : raw;
}

export async function setPpvFixed(model: string, line: string, value: PpvFixed): Promise<void> {
  await getRedis().set(`ppvfix:${model}:${line}`, JSON.stringify(value));
}

// ── Envoi d'une vidéo PPV au bot en morceaux (porte d'admin /api/webhook?setup=)
// Un appel au serveur est limité à 4,5 Mo et une commande Redis à 1 Mo : la
// vidéo arrive en morceaux d'environ 700 Ko, gardés 1 h puis supprimés.
export async function setUploadChunk(id: string, i: number, b64: string): Promise<void> {
  await getRedis().set(`ppvup:${id}:${i}`, b64, { ex: 3600 });
}

export async function getUploadChunk(id: string, i: number): Promise<string | null> {
  return getRedis().get<string>(`ppvup:${id}:${i}`);
}

export async function deleteUploadChunks(id: string, n: number): Promise<void> {
  const keys = Array.from({ length: n }, (_, i) => `ppvup:${id}:${i}`);
  if (keys.length > 0) await getRedis().del(...keys);
}

/** Une seule génération PPV à la fois par opérateur (2 min max) */
export async function lockPpv(userId: number): Promise<boolean> {
  const ok = await getRedis().set(`ppvlock:${userId}`, "1", { nx: true, ex: 120 });
  return ok === "OK";
}

export async function unlockPpv(userId: number): Promise<void> {
  await getRedis().del(`ppvlock:${userId}`);
}

export async function recordPpv(userId: number, modelKey: string): Promise<void> {
  const p = getRedis().pipeline();
  p.hincrby("stats:ppv:model", modelKey, 1);
  p.hincrby("stats:ppv:user", String(userId), 1);
  await p.exec();
}

export async function readPpvStats(): Promise<{
  byModel: Record<string, number>;
  byUser: Record<string, number>;
}> {
  const redis = getRedis();
  const [byModel, byUser] = await Promise.all([
    redis.hgetall<Record<string, number>>("stats:ppv:model"),
    redis.hgetall<Record<string, number>>("stats:ppv:user"),
  ]);
  return { byModel: byModel ?? {}, byUser: byUser ?? {} };
}

/** Incrémente les compteurs après une génération réussie */
export async function recordGeneration(
  userId: number,
  modelKey: string,
  chars: number
): Promise<void> {
  const p = getRedis().pipeline();
  p.hincrby("stats:gen:model", modelKey, 1);
  p.hincrby("stats:chars:model", modelKey, chars);
  p.hincrby("stats:gen:user", String(userId), 1);
  p.hincrby("stats:chars:user", String(userId), chars);
  await p.exec();
}

export interface Stats {
  genByModel: Record<string, number>;
  charsByModel: Record<string, number>;
  genByUser: Record<string, number>;
  charsByUser: Record<string, number>;
}

export async function readStats(): Promise<Stats> {
  const redis = getRedis();
  const [genByModel, charsByModel, genByUser, charsByUser] = await Promise.all(
    STATS_KEYS.map((k) => redis.hgetall<Record<string, number>>(k))
  );
  return {
    genByModel: genByModel ?? {},
    charsByModel: charsByModel ?? {},
    genByUser: genByUser ?? {},
    charsByUser: charsByUser ?? {},
  };
}

export async function resetStats(): Promise<void> {
  await getRedis().del(
    ...STATS_KEYS,
    "stats:video:model",
    "stats:video:user",
    "stats:ppv:model",
    "stats:ppv:user"
  );
}
