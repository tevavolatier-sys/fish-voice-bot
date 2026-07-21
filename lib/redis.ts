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
