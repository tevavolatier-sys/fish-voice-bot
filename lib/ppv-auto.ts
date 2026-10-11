// PPV perso AUTOMATIQUE (Sienna) — demande de Teva du 11/10/2026.
// Quand un fan achète le PPV de bienvenue (« OUVRE CA et attends 5 min… »,
// envoyé par le chatter depuis le CRM) :
//   1. prénom du fan : le nom modifié par le chatter sur OF (display_name),
//      sinon la détection pseudo → prénom du vocal de bienvenue ;
//   2. preview + PPV 1 avec le prénom, EXACTEMENT comme « /ppv Prénom » (lib/ppv-build.ts) ;
//   3. les 2 vidéos dans le vault OF, dans un dossier « PPV1 - Prénom » ;
//   4. alerte Telegram (bot dédié, en anglais) au groupe des chatters ;
//   5. le dossier est supprimé 30 min après, les fichiers 24 h après (nettoyage
//      déclenché par les webhooks suivants et par GET /api/ppv-cron).
import { cleanFanName } from "./ppv.js";
import { fanFirstName } from "./fan-name.js";
import {
  addToVaultList,
  createVaultList,
  deleteVaultList,
  deleteVaultMedia,
  getChatMessageText,
  uploadToVault,
} from "./onlyfans.js";
import { buildPpvForFan, ppvReady } from "./ppv-build.js";
import { getRedis } from "./redis.js";

export interface PpvAutoSettings {
  enabled: boolean;
  /** Début du texte du PPV de bienvenue (comparé sans accents, majuscules, emojis) */
  triggerText: string;
  /** Minutes avant suppression du dossier du vault */
  listMinutes: number;
  /** Heures avant suppression des fichiers du vault */
  mediaHours: number;
}

export const DEFAULT_PPV_AUTO: PpvAutoSettings = {
  enabled: false,
  triggerText: "OUVRE CA et attends 5 min le temps que jme remaquille",
  listMinutes: 30,
  mediaHours: 24,
};

export interface PpvAutoLog {
  at: string;
  fan: string;
  display: string;
  username: string;
  name: string;
  amount: number;
  status: "done" | "noname" | "error";
  /** D'où vient le prénom : custom = mis par le chatter sur OF, guessed = deviné sur le pseudo */
  source?: "custom" | "guessed";
  error?: string;
  listName?: string;
  /** Secondes entre l'achat et le dossier prêt */
  elapsedSec?: number;
  manual?: boolean;
}

interface Cleanup {
  acct: string;
  listId: string;
  mediaIds: string[];
  listAt: number; // ms : suppression du dossier
  mediaAt: number; // ms : suppression des fichiers
  listDone?: boolean;
}

const CFG_KEY = "ppvauto:cfg";
const LOG_KEY = "ppvauto:log";
const CLEAN_KEY = "ppvauto:cleanup";

const parse = <T>(raw: unknown): T | null => (raw == null ? null : typeof raw === "string" ? (JSON.parse(raw) as T) : (raw as T));

export async function getPpvAutoSettings(): Promise<PpvAutoSettings> {
  const cfg = parse<Partial<PpvAutoSettings>>(await getRedis().get(CFG_KEY));
  return { ...DEFAULT_PPV_AUTO, ...(cfg ?? {}) };
}

export async function savePpvAutoSettings(s: Partial<PpvAutoSettings>): Promise<void> {
  const cur = await getPpvAutoSettings();
  const clean: PpvAutoSettings = {
    enabled: Boolean(s.enabled ?? cur.enabled),
    triggerText: String(s.triggerText ?? cur.triggerText).trim().slice(0, 300) || DEFAULT_PPV_AUTO.triggerText,
    listMinutes: Math.max(5, Math.min(1440, Number(s.listMinutes ?? cur.listMinutes) || 30)),
    mediaHours: Math.max(1, Math.min(240, Number(s.mediaHours ?? cur.mediaHours) || 24)),
  };
  await getRedis().set(CFG_KEY, JSON.stringify(clean));
}

export async function readPpvAutoLog(): Promise<PpvAutoLog[]> {
  const rows = await getRedis().lrange<string | PpvAutoLog>(LOG_KEY, 0, 99);
  return rows.map((r) => parse<PpvAutoLog>(r)!);
}

async function addLog(entry: PpvAutoLog): Promise<void> {
  const r = getRedis();
  await r.lpush(LOG_KEY, JSON.stringify(entry));
  await r.ltrim(LOG_KEY, 0, 199);
}

/** Texte comparable : minuscules, sans accents, emojis ni ponctuation, espaces réduits */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Le message acheté est-il le PPV de bienvenue ? */
export function isTriggerText(messageText: string, trigger: string): boolean {
  const t = normalizeText(trigger);
  if (!t) return false;
  return normalizeText(messageText).startsWith(t);
}

// ── Alerte Telegram (bot dédié) ─────────────────────────────────────────────
export function alertConfigured(): boolean {
  return Boolean(process.env.PPV_ALERT_BOT_TOKEN && process.env.PPV_ALERT_CHAT_ID);
}

export async function sendAlert(text: string): Promise<void> {
  const token = process.env.PPV_ALERT_BOT_TOKEN;
  const chat = process.env.PPV_ALERT_CHAT_ID;
  if (!token || !chat) throw new Error("Bot d'alerte non configuré (PPV_ALERT_BOT_TOKEN / PPV_ALERT_CHAT_ID).");
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Telegram ${r.status} : ${(await r.text()).slice(0, 200)}`);
}

/** Vidéo envoyée dans le groupe d'alerte (tests depuis l'interface) */
export async function sendAlertVideo(video: Buffer, filename: string, caption: string): Promise<void> {
  const token = process.env.PPV_ALERT_BOT_TOKEN;
  const chat = process.env.PPV_ALERT_CHAT_ID;
  if (!token || !chat) throw new Error("Bot d'alerte non configuré.");
  const form = new FormData();
  form.set("chat_id", chat);
  form.set("caption", caption);
  form.set("supports_streaming", "true");
  form.set("video", new Blob([new Uint8Array(video)], { type: "video/mp4" }), filename);
  const r = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`Telegram ${r.status} : ${(await r.text()).slice(0, 200)}`);
}

// ── Nettoyage du vault ──────────────────────────────────────────────────────
async function scheduleCleanup(c: Cleanup): Promise<void> {
  await getRedis().zadd(CLEAN_KEY, { score: c.listAt, member: JSON.stringify(c) });
}

/** Supprime les dossiers / fichiers arrivés à échéance. Appelé par les webhooks et /api/ppv-cron. */
export async function runCleanup(): Promise<{ lists: number; media: number }> {
  const r = getRedis();
  const now = Date.now();
  const due = await r.zrange<string[]>(CLEAN_KEY, 0, now, { byScore: true });
  let lists = 0, media = 0;
  for (const raw of due) {
    const c = parse<Cleanup>(raw);
    if (!c) { await r.zrem(CLEAN_KEY, raw); continue; }
    try {
      if (!c.listDone && now >= c.listAt) {
        await deleteVaultList(c.acct, c.listId).catch((e) => { if (!/404/.test(String(e))) throw e; });
        lists++;
        // Reprogrammé pour la suppression des fichiers
        await r.zrem(CLEAN_KEY, raw);
        await r.zadd(CLEAN_KEY, { score: c.mediaAt, member: JSON.stringify({ ...c, listDone: true }) });
        continue;
      }
      if (c.listDone && now >= c.mediaAt) {
        await deleteVaultMedia(c.acct, c.mediaIds).catch((e) => { if (!/404/.test(String(e))) throw e; });
        media++;
        await r.zrem(CLEAN_KEY, raw);
      }
    } catch (err) {
      console.error("nettoyage vault:", err);
      // On retentera au prochain passage (dans 10 min minimum)
      await r.zrem(CLEAN_KEY, raw);
      await r.zadd(CLEAN_KEY, { score: now + 10 * 60_000, member: raw });
    }
  }
  return { lists, media };
}

export async function pendingCleanups(): Promise<number> {
  return (await getRedis().zcard(CLEAN_KEY)) ?? 0;
}

// ── Le cœur : un achat de PPV ───────────────────────────────────────────────
export interface PpvPurchase {
  accountId: string;
  fanId: string;
  chatId: string;
  messageId: string;
  display: string; // fan.display_name (nom mis par le chatter) ou fan.name
  name: string; // fan.name
  username: string;
  amount: number;
  at: number; // ms
}

/** Étiquettes que les chatters mettent parfois à la place du nom : pas des prénoms */
const NOT_FIRST_NAMES = /^(whale|vip|fan|client|spender|timewaster|tw|big|lead|new|hot|warm|cold|sub|user|none|test|inconnu|unknown|cash|rich|poor|broke)$/i;

/** Le nom mis par le chatter, seulement si c'est clairement UN prénom */
export function customFirstName(display: string): string | null {
  const first = (display || "").trim().split(/\s+/)[0] ?? "";
  if (!/^[\p{L}][\p{L}'’-]{1,19}$/u.test(first)) return null;
  if (/\d/.test(display) || NOT_FIRST_NAMES.test(first.replace(/[^\p{L}]/gu, ""))) return null;
  return cleanFanName(first);
}

const chatLink = (fanId: string) => `https://onlyfans.com/my/chats/chat/${fanId}`;

/**
 * Lance la fabrication pour un fan (prénom déjà connu). Renvoie le journal.
 * `force` : renvoi manuel depuis l'interface (ignore « déjà fait »).
 */
export async function producePpvForFan(p: PpvPurchase, name: string, force = false, source?: "custom" | "guessed"): Promise<PpvAutoLog> {
  const s = await getPpvAutoSettings();
  const log: PpvAutoLog = {
    at: new Date().toISOString(), fan: p.fanId, display: p.display, username: p.username,
    name, amount: p.amount, status: "error", manual: force || undefined, source,
  };
  const doneKey = `ppvauto:done:${p.accountId}:${p.fanId}`;
  if (!force && (await getRedis().set(doneKey, "1", { nx: true })) !== "OK") {
    // Déjà traité pour ce fan : pas de 2e dossier
    return { ...log, status: "error", error: "Déjà fait pour ce fan" };
  }
  try {
    const built = await buildPpvForFan(name);
    const slug = name.normalize("NFD").replace(/[^\w-]+/g, "").toLowerCase() || "fan";
    const [previewId, paid1Id] = await Promise.all([
      uploadToVault(p.accountId, built.preview.video, `preview-${slug}.mp4`),
      uploadToVault(p.accountId, built.paid1.video, `ppv1-${slug}.mp4`),
    ]);
    const listName = `PPV1 - ${name}`;
    const listId = await createVaultList(p.accountId, listName);
    await addToVaultList(p.accountId, listId, [previewId, paid1Id]);
    await scheduleCleanup({
      acct: p.accountId, listId, mediaIds: [previewId, paid1Id],
      listAt: Date.now() + s.listMinutes * 60_000, mediaAt: Date.now() + s.mediaHours * 3600_000,
    });
    log.status = "done";
    log.listName = listName;
    log.elapsedSec = Math.round((Date.now() - p.at) / 1000);
    await sendAlert(
      `💰 ${p.display || p.username || p.fanId}${p.username ? ` (@${p.username})` : ""} just bought the welcome PPV ($${p.amount}).\n` +
      `🎬 His free preview + PPV 1 videos with his name (${name}) are ready in the vault → folder “${listName}” (auto-deleted in ${s.listMinutes} min).\n` +
      `💬 Chat: ${chatLink(p.fanId)}`
    ).catch((e) => console.error("alerte Telegram:", e));
  } catch (err) {
    log.error = String((err as Error)?.message ?? err).slice(0, 300);
    log.elapsedSec = Math.round((Date.now() - p.at) / 1000);
    await getRedis().del(doneKey); // on pourra relancer depuis l'interface
    await sendAlert(
      `⚠️ ${p.display || p.username || p.fanId} bought the welcome PPV ($${p.amount}) but the custom videos FAILED: ${log.error}\n` +
      `Make them by hand with /ppv ${name} in the voice bot. Chat: ${chatLink(p.fanId)}`
    ).catch(() => {});
  }
  await addLog(log);
  return log;
}

/** Point d'entrée du webhook messages.ppv.unlocked */
export async function handlePpvUnlocked(p: PpvPurchase): Promise<void> {
  const s = await getPpvAutoSettings();
  if (!s.enabled) return;
  // 1 requête : le texte du message acheté → est-ce le PPV de bienvenue ?
  let text = "";
  try {
    text = await getChatMessageText(p.accountId, p.chatId, p.messageId);
  } catch (err) {
    console.error("texte du PPV acheté illisible:", err);
    return;
  }
  if (!isTriggerText(text, s.triggerText)) return;

  // Prénom : nom mis par le chatter sur OF s'il ressemble à un prénom (un seul mot,
  // lettres, pas une étiquette comme « Whale » ou « VIP »), sinon détection IA sur le pseudo
  const custom = customFirstName(p.display);
  // Secours : nom OF du fan puis son pseudo (jamais la note du chatter)
  const name = custom ?? (await fanFirstName(p.name, p.username));
  if (!name) {
    await addLog({
      at: new Date().toISOString(), fan: p.fanId, display: p.display, username: p.username,
      name: "", amount: p.amount, status: "noname", error: "Prénom illisible",
    });
    await sendAlert(
      `⚠️ ${p.display || p.username || p.fanId} bought the welcome PPV ($${p.amount}) but I can't read his first name from “${p.display || p.name || p.username}”.\n` +
      `Ask him his name, then rename him on OnlyFans and hit “Redo” in the interface, or make the videos with /ppv Name in the voice bot. Chat: ${chatLink(p.fanId)}`
    ).catch(() => {});
    return;
  }
  await producePpvForFan(p, name, false, custom ? "custom" : "guessed");
}

export { ppvReady };
