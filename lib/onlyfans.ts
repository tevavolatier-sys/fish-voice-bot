// Client OnlyFansAPI (docs.onlyfansapi.com) — même API que le CRM.
// Chaque appel est compté dans Redis (forfait : 20 000 requêtes / mois).
import { getRedis } from "./redis.js";

const BASE = () => process.env.ONLYFANS_API_BASE || "https://app.onlyfansapi.com/api";

/** Clé Redis du compteur du mois en cours (ex. ofreq:2026-10) */
const monthKey = () => `ofreq:${new Date().toISOString().slice(0, 7)}`;

export async function requestsThisMonth(): Promise<number> {
  return Number(await getRedis().get<number>(monthKey())) || 0;
}

async function count(): Promise<void> {
  const r = getRedis();
  const key = monthKey();
  await r.incr(key);
  await r.expire(key, 40 * 24 * 3600);
}

async function api<T>(accountId: string, route: string, init: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${process.env.ONLYFANS_API_KEY}`,
    Accept: "application/json",
  };
  if (init.body && !(init.body instanceof FormData)) headers["Content-Type"] = "application/json";
  let res: Response | null = null;
  let text = "";
  // Panne passagère du proxy OnlyFansAPI (503 « not_sent ») : 2 nouveaux essais
  for (let i = 0; i < 3; i++) {
    await count();
    res = await fetch(`${BASE()}/${accountId}${route}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(45_000),
    });
    text = await res.text();
    if (res.status !== 503 || !/not_sent/.test(text)) break;
    await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
  }
  if (!res!.ok) throw new Error(`OnlyFansAPI ${res!.status} : ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Envoie un fichier sur OnlyFans et renvoie son id à joindre à un message */
export async function uploadMedia(accountId: string, file: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(file)]), filename);
  const r = await api<{ prefixed_id?: string; data?: { prefixed_id?: string } }>(
    accountId,
    "/media/upload",
    { method: "POST", body: form }
  );
  const id = r.prefixed_id ?? r.data?.prefixed_id;
  if (!id) throw new Error("OnlyFansAPI : upload sans identifiant de média");
  return id;
}

export async function sendChatMessage(
  accountId: string,
  fanId: string,
  text: string,
  mediaIds: string[]
): Promise<void> {
  const body: Record<string, unknown> = { text };
  if (mediaIds.length) body.mediaFiles = mediaIds;
  await api(accountId, `/chats/${fanId}/messages`, { method: "POST", body: JSON.stringify(body) });
}
