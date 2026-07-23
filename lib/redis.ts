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
  await getRedis().del(...STATS_KEYS);
}
