// Client OnlyFansAPI (docs.onlyfansapi.com) — même API que le CRM.
// Chaque appel est compté dans Redis (forfait : 20 000 requêtes / mois).
import { randomUUID } from "node:crypto";
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
    ...((init.headers as Record<string, string> | undefined) ?? {}),
    Authorization: `Bearer ${process.env.ONLYFANS_API_KEY}`,
    Accept: "application/json",
  };
  if (init.body && !(init.body instanceof FormData)) headers["Content-Type"] = "application/json";
  let res: Response | null = null;
  let text = "";
  // Panne passagère du proxy OnlyFansAPI (503 « not_sent ») : 2 nouveaux essais
  // Proxy OnlyFansAPI → OnlyFans parfois indisponible quelques secondes (503 « not_sent »,
  // rien n'est parti) : on réessaie jusqu'à 6 fois, ~75 s au total, pour rester dans les 2 min.
  const waits = [4000, 8000, 12000, 20000, 30000];
  for (let i = 0; i <= waits.length; i++) {
    await count();
    res = await fetch(`${BASE()}/${accountId}${route}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(45_000),
    });
    text = await res.text();
    if (res.status !== 503 || !/not_sent/.test(text) || i === waits.length) break;
    await new Promise((r) => setTimeout(r, waits[i]));
  }
  if (!res!.ok) throw new Error(`OnlyFansAPI ${res!.status} : ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Envoie un fichier sur OnlyFans et renvoie son id à joindre à un message */
export async function uploadMedia(accountId: string, file: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  const type = /\.jpe?g$/i.test(filename) ? "image/jpeg" : /\.png$/i.test(filename) ? "image/png" : /\.mp3$/i.test(filename) ? "audio/mpeg" : "application/octet-stream";
  form.set("file", new Blob([new Uint8Array(file)], { type }), filename);
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
  // Un texte vide est refusé (422 « text must be a string », Laravel le transforme en null) :
  // vocal seul → pas de champ text ; si l'API l'exige quand même, on met un emoji.
  // Idempotency-Key (doc OnlyFansAPI) : une clé par corps envoyé, les réessais ne doublonnent pas
  const send = (t?: string) => {
    const body: Record<string, unknown> = {};
    if (t) body.text = t;
    if (mediaIds.length) body.mediaFiles = mediaIds;
    return api(accountId, `/chats/${fanId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Idempotency-Key": randomUUID() },
    });
  };
  try {
    await send(text.trim() || undefined);
  } catch (err) {
    if (text.trim() || !/text/i.test(String(err))) throw err;
    await send("🎙️");
  }
}

// ── Webhooks OnlyFansAPI (API globale, pas par compte) ──────────────────────
export interface OfWebhook {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  has_signing_secret: boolean;
}

async function global<T>(route: string, init: RequestInit = {}): Promise<T> {
  await count();
  const res = await fetch(`${BASE()}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.ONLYFANS_API_KEY}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OnlyFansAPI ${res.status} : ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function listWebhooks(): Promise<OfWebhook[]> {
  const r = await global<{ data?: OfWebhook[] } | OfWebhook[]>("/webhooks");
  return Array.isArray(r) ? r : (r.data ?? []);
}

/**
 * S'assure que le webhook de cette URL existe et écoute bien tous les événements voulus
 * (PUT remplace la liste : on envoie l'union). Créé avec le secret si absent.
 */
export async function ensureWebhook(url: string, wanted: string[]): Promise<{ id: string; events: string[]; created: boolean }> {
  const all = await listWebhooks();
  const mine = all.find((w) => w.url === url);
  if (mine) {
    const events = Array.from(new Set([...(mine.events ?? []), ...wanted]));
    const unchanged = mine.enabled && events.length === (mine.events ?? []).length;
    if (!unchanged) {
      await global(`/webhooks/${mine.id}`, {
        method: "PUT",
        body: JSON.stringify({ endpoint_url: url, events, account_scope: "global", enabled: true }),
      });
    }
    return { id: mine.id, events, created: false };
  }
  const r = await global<{ data?: OfWebhook } & Partial<OfWebhook>>("/webhooks", {
    method: "POST",
    body: JSON.stringify({
      endpoint_url: url,
      signing_secret: process.env.ONLYFANS_WEBHOOK_SECRET,
      events: wanted,
      account_scope: "global",
    }),
  });
  const w = r.data ?? (r as OfWebhook);
  return { id: w.id, events: wanted, created: true };
}
