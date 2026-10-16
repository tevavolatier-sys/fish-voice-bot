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
  getChatMessageInfo,
  getChatMessageText,
  uploadToVault,
} from "./onlyfans.js";
import { buildPpvForFan, ppvReady } from "./ppv-build.js";
import { getRedis } from "./redis.js";
import { ACCOUNTS, SIENNA, scoped, tagOf, type OfAccount } from "./accounts.js";
import { creditsCapReached } from "./onlyfans.js";
import { alertCapOnce, resolveAccount } from "./welcome.js";
import { isTracked, trackBought, trackMade } from "./ppv-track.js";

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
  // Début court : plusieurs versions du script circulent (« jme » / « je me », « pr » / « pour »), vu le 12/10
  triggerText: "OUVRE CA et attends 5 min | OUVRE CA et donne moi genre",
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

// Réglages, journal et contexte par compte (Sienna : clés d'origine). Nettoyage et nouveaux
// essais : files communes (chaque entrée garde son compte acct_…).
const CFG_KEY = (a: OfAccount) => scoped("ppvauto:cfg", a);
const LOG_KEY = (a: OfAccount) => scoped("ppvauto:log", a);
const CLEAN_KEY = "ppvauto:cleanup";
const RETRY_KEY = "ppvauto:retry";

/** Début du PPV de bienvenue par langue (à remplacer par le vrai texte des chatters de Lena / Jade) */
const TRIGGER_BY_LANG: Record<OfAccount["lang"], string> = {
  fr: DEFAULT_PPV_AUTO.triggerText,
  de: "MACH DAS AUF und warte 5 Min",
  en: "OPEN THIS and wait 5 min",
};
const defaultPpvAuto = (a: OfAccount): PpvAutoSettings => ({ ...DEFAULT_PPV_AUTO, triggerText: TRIGGER_BY_LANG[a.lang] });

const parse = <T>(raw: unknown): T | null => (raw == null ? null : typeof raw === "string" ? (JSON.parse(raw) as T) : (raw as T));

export async function getPpvAutoSettings(a: OfAccount = SIENNA): Promise<PpvAutoSettings> {
  const cfg = parse<Partial<PpvAutoSettings>>(await getRedis().get(CFG_KEY(a)));
  return { ...defaultPpvAuto(a), ...(cfg ?? {}) };
}

/** Comptes dont le PPV auto est activé (pour le rapport et le cron) */
export async function activePpvAccounts(): Promise<OfAccount[]> {
  const out: OfAccount[] = [];
  for (const a of ACCOUNTS) if ((await getPpvAutoSettings(a)).enabled) out.push(a);
  return out;
}

export async function savePpvAutoSettings(s: Partial<PpvAutoSettings>, a: OfAccount = SIENNA): Promise<void> {
  const cur = await getPpvAutoSettings(a);
  const clean: PpvAutoSettings = {
    enabled: Boolean(s.enabled ?? cur.enabled),
    triggerText: String(s.triggerText ?? cur.triggerText).trim().slice(0, 300) || defaultPpvAuto(a).triggerText,
    listMinutes: Math.max(5, Math.min(1440, Number(s.listMinutes ?? cur.listMinutes) || 30)),
    mediaHours: Math.max(1, Math.min(240, Number(s.mediaHours ?? cur.mediaHours) || 24)),
  };
  await getRedis().set(CFG_KEY(a), JSON.stringify(clean));
}

export async function readPpvAutoLog(a: OfAccount = SIENNA): Promise<PpvAutoLog[]> {
  const rows = await getRedis().lrange<string | PpvAutoLog>(LOG_KEY(a), 0, 99);
  return rows.map((r) => parse<PpvAutoLog>(r)!);
}

async function addLog(entry: PpvAutoLog, a: OfAccount): Promise<void> {
  const r = getRedis();
  await r.lpush(LOG_KEY(a), JSON.stringify(entry));
  await r.ltrim(LOG_KEY(a), 0, 199);
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
  // Plusieurs versions du PPV de bienvenue circulent (16/10 : « …et donne moi genre 5-6 min… ») :
  // plusieurs débuts possibles, séparés par « | » ou un retour à la ligne
  const msg = normalizeText(messageText);
  return trigger.split(/[|\n]/).map(normalizeText).some((t) => t.length > 0 && msg.startsWith(t));
}

// ── Alerte Telegram (bot dédié) ─────────────────────────────────────────────
export function alertConfigured(): boolean {
  return Boolean(process.env.PPV_ALERT_BOT_TOKEN && process.env.PPV_ALERT_CHAT_ID);
}

export async function sendAlert(text: string, markup?: unknown): Promise<void> {
  const token = process.env.PPV_ALERT_BOT_TOKEN;
  const chat = process.env.PPV_ALERT_CHAT_ID;
  if (!token || !chat) throw new Error("Bot d'alerte non configuré (PPV_ALERT_BOT_TOKEN / PPV_ALERT_CHAT_ID).");
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Telegram ${r.status} : ${(await r.text()).slice(0, 200)}`);
}

/**
 * Bouton « refaire avec le bon prénom » sous les alertes (géré par api/ppv-bot.ts).
 * Sienna : « redo:<fan> » (inchangé) ; autres comptes : « redo:<compte>:<fan> ».
 */
export const redoButton = (fanId: string, label = "✏️ Wrong name? Redo with the right one", a: OfAccount = SIENNA) => ({
  inline_keyboard: [[{ text: label, callback_data: a.legacy ? `redo:${fanId}` : `redo:${a.key}:${fanId}` }]],
});

/** Contexte d'un achat, gardé 7 jours pour pouvoir le refaire depuis Telegram */
export async function saveContext(p: PpvPurchase, a: OfAccount = SIENNA): Promise<void> {
  await getRedis().set(scoped(`ppvauto:ctx:${p.fanId}`, a), JSON.stringify(p), { ex: 7 * 24 * 3600 });
}
export async function getContext(fanId: string, a: OfAccount = SIENNA): Promise<PpvPurchase | null> {
  return parse<PpvPurchase>(await getRedis().get(scoped(`ppvauto:ctx:${fanId}`, a)));
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
export async function runCleanup(): Promise<{ lists: number; media: number; retried?: number }> {
  const r = getRedis();
  const now = Date.now();
  // Nouveaux essais après une panne d'OnlyFans (un seul par passage : ~1 min de travail)
  let retried = 0;
  // Plafond journalier global de crédits atteint : pas de nouvel essai (le nettoyage, lui, continue)
  const capped = (await creditsCapReached().catch(() => ({ over: false }))).over;
  const retry = capped ? undefined : (await r.zrange<string[]>(RETRY_KEY, 0, now, { byScore: true }))[0];
  if (retry && (await r.zrem(RETRY_KEY, retry)) === 1) {
    const j = parse<{ p: PpvPurchase; name: string; source?: "custom" | "guessed"; tries: number }>(retry);
    if (j) { await producePpvForFan(j.p, j.name, true, j.source, j.tries); retried = 1; }
  }
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
  return { lists, media, retried };
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
  // Les chatters mettent parfois une NOTE dans le nom (« prêt de Nantes je travaille… ») :
  // plus de 3 mots = une note, pas un prénom (vu le 11/10/2026)
  // Format courant des chatters : « Mathieu | Toulon | yacht captain », « Fabien | 30 » :
  // seule la partie avant le premier séparateur compte (12/10/2026)
  const head = (display || "").split(/\s*(?:[|•·\/,(]|\s-\s)\s*/)[0] ?? "";
  // « Haute-Savoie- electrician » : un mot collé à un tiret final = une étiquette (lieu…), pas un prénom (15/10)
  if (/^\S+-(\s|$)/.test(head.trim())) return null;
  const words = head.trim().split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (words.length === 0 || words.length > 3) return null;
  const first = words[0];
  if (/^(pr[eê]t|de|du|le|la|les|un|une|il|je|mon|ma|aime|veut|est|mec|gars|bro|ok|non|oui)$/i.test(first)) return null;
  if (!/^[\p{L}][\p{L}'’-]{1,19}$/u.test(first)) return null;
  if (NOT_FIRST_NAMES.test(first.replace(/[^\p{L}]/gu, ""))) return null;
  // Pas un prénom prononçable (« Zzzzzzzjhhhhh », « xkq ») : 3 lettres identiques, pas de voyelle, trop long (14/10)
  if (/(\p{L})\1\1/iu.test(first) || !/[aeiouyàâäéèêëîïôöùûü]/i.test(first) || first.length > 14) return null;
  return cleanFanName(first);
}


/**
 * Lance la fabrication pour un fan (prénom déjà connu). Renvoie le journal.
 * `force` : renvoi manuel depuis l'interface (ignore « déjà fait »).
 */
export async function producePpvForFan(p: PpvPurchase, name: string, force = false, source?: "custom" | "guessed", tries = 0): Promise<PpvAutoLog> {
  const a = (await resolveAccount(p.accountId)) ?? SIENNA;
  const tag = tagOf(a);
  const s = await getPpvAutoSettings(a);
  const log: PpvAutoLog = {
    at: new Date().toISOString(), fan: p.fanId, display: p.display, username: p.username,
    name, amount: p.amount, status: "error", manual: force || undefined, source,
  };
  if (p.display || p.username) await saveContext(p, a).catch(() => {});
  const doneKey = `ppvauto:done:${p.accountId}:${p.fanId}`;
  if (!force && (await getRedis().set(doneKey, "1", { nx: true })) !== "OK") {
    // Déjà traité pour ce fan : pas de 2e dossier
    return { ...log, status: "error", error: "Déjà fait pour ce fan" };
  }
  try {
    const built = await buildPpvForFan(name, a);
    const slug = name.normalize("NFD").replace(/[^\w-]+/g, "").toLowerCase() || "fan";
    // OnlyFans renvoie parfois un 400 « Bad Request » passager (vu le 12/10 : ok au 3e essai) :
    // chaque étape est retentée 2 fois. Les uploads l'un après l'autre (moins de 400).
    const again = async <T>(f: () => Promise<T>): Promise<T> => {
      for (let i = 0; ; i++) {
        try { return await f(); } catch (e) {
          // 503 « OnlyFans is currently experiencing issues » : panne de quelques dizaines de s (vu le 12/10)
          if (i >= 4 || !/OnlyFansAPI (400|5\d\d)/.test(String(e)) || /en traitement/.test(String(e))) throw e;
          await new Promise((r) => setTimeout(r, [5000, 10000, 20000, 30000][i]));
        }
      }
    };
    // Les 2 envois en parallèle (en différé, chacun suivi jusqu'à ~4 min)
    const [previewId, paid1Id] = await Promise.all([
      again(() => uploadToVault(p.accountId, built.preview.video, `preview-${slug}.mp4`)),
      again(() => uploadToVault(p.accountId, built.paid1.video, `ppv1-${slug}.mp4`)),
    ]);
    const listName = `PPV1 - ${name}`;
    const listId = await again(() => createVaultList(p.accountId, listName));
    await again(() => addToVaultList(p.accountId, listId, [previewId, paid1Id]));
    await scheduleCleanup({
      acct: p.accountId, listId, mediaIds: [previewId, paid1Id],
      listAt: Date.now() + s.listMinutes * 60_000, mediaAt: Date.now() + s.mediaHours * 3600_000,
    });
    await trackMade(p.accountId, p.fanId, name, [previewId, paid1Id]).catch((e) => console.error("suivi:", e));
    log.status = "done";
    log.listName = listName;
    log.elapsedSec = Math.round((Date.now() - p.at) / 1000);
    await sendAlert(
      `${tag}💰 ${p.display || p.username || p.fanId}${p.username ? ` (@${p.username})` : ""} just bought the welcome PPV ($${p.amount}).\n` +
      `🎬 His free preview + PPV 1 videos with his name (${name}) are ready in the vault → folder “${listName}” (auto-deleted in ${s.listMinutes} min).`,
      redoButton(p.fanId, undefined, a)
    ).catch((e) => console.error("alerte Telegram:", e));
  } catch (err) {
    log.error = String((err as Error)?.message ?? err).slice(0, 800);
    log.elapsedSec = Math.round((Date.now() - p.at) / 1000);
    await getRedis().del(doneKey); // on pourra relancer depuis l'interface
    // Panne d'OnlyFans (5xx) : nouvel essai automatique toutes les 5 min, 6 fois max (30 min)
    if (/OnlyFansAPI 5\d\d/.test(log.error) && tries < 6) {
      await getRedis().zadd(RETRY_KEY, { score: Date.now() + 5 * 60_000, member: JSON.stringify({ p, name, source, tries: tries + 1 }) });
      if (tries === 0) {
        await sendAlert(
          `${tag}⏳ ${p.display || p.username || p.fanId} bought the welcome PPV (${p.amount}) but OnlyFans is down right now. ` +
          `I'll retry ${name}'s videos automatically every 5 min, you'll get an alert when they're ready.`,
          redoButton(p.fanId, "✏️ Change the name", a)
        ).catch(() => {});
      }
      log.error = `OnlyFans en panne, nouvel essai auto dans 5 min (${tries + 1}/6) — ${log.error}`;
      await addLog(log, a);
      return log;
    }
    await sendAlert(
      `${tag}⚠️ ${p.display || p.username || p.fanId} bought the welcome PPV ($${p.amount}) but the custom videos FAILED: ${log.error}\n` +
      `Make them by hand with /ppv ${name} in the voice bot, or tap the button to try again.`,
      redoButton(p.fanId, "🔁 Try again / change the name", a)
    ).catch(() => {});
  }
  await addLog(log, a);
  return log;
}

/** Point d'entrée du webhook messages.ppv.unlocked */
export async function handlePpvUnlocked(p: PpvPurchase): Promise<void> {
  const a = await resolveAccount(p.accountId);
  if (!a) return;
  const s = await getPpvAutoSettings(a);
  if (!s.enabled) return;
  // Plafond journalier global de crédits : on s'arrête (alerte une fois par jour)
  const cap = await creditsCapReached();
  if (cap.over) {
    await alertCapOnce(cap.used, cap.cap).catch(() => {});
    return;
  }
  // 1 requête : le message acheté (texte + médias) → est-ce le PPV de bienvenue ? ou un PPV perso suivi ?
  let text = "";
  let mediaIds: string[] = [];
  try {
    ({ text, mediaIds } = await getChatMessageInfo(p.accountId, p.chatId, p.messageId));
  } catch (err) {
    console.error("message du PPV acheté illisible:", err);
    return;
  }
  // Unlock rate des PPV perso : le fan vient-il d'acheter le PPV contenant SES vidéos ?
  if (await isTracked(p.accountId, p.fanId).catch(() => false)) {
    await trackBought(p.accountId, p.fanId, p.messageId, p.amount, mediaIds).catch((e) => console.error("suivi achat:", e));
  }
  if (!isTriggerText(text, s.triggerText)) return;
  await saveContext(p, a).catch(() => {});

  // Prénom : nom mis par le chatter sur OF s'il ressemble à un prénom (un seul mot,
  // lettres, pas une étiquette comme « Whale » ou « VIP »), sinon détection IA sur le pseudo
  const custom = customFirstName(p.display);
  // Secours : nom OF du fan puis son pseudo (jamais la note du chatter)
  const name = custom ?? (await fanFirstName(p.name, p.username));
  if (!name) {
    await addLog({
      at: new Date().toISOString(), fan: p.fanId, display: p.display, username: p.username,
      name: "", amount: p.amount, status: "noname", error: "Prénom illisible",
    }, a);
    await sendAlert(
      `${tagOf(a)}⚠️ ${p.display || p.username || p.fanId} bought the welcome PPV ($${p.amount}) but I can't read his first name from “${p.display || p.name || p.username}”.\n` +
      `Ask him his name, then tap the button and type it.`,
      redoButton(p.fanId, "✏️ Type his first name", a)
    ).catch(() => {});
    return;
  }
  await producePpvForFan(p, name, false, custom ? "custom" : "guessed");
}

export { ppvReady };
