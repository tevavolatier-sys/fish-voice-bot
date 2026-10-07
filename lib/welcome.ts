// Vocal de bienvenue automatique (Sienna seulement pour l'instant).
// À chaque nouvel abonné OnlyFans :
//   - prénom lisible → « {prénom}… » + PARTIE FIXE (même prise pour tous les fans)
//   - pseudo illisible → vocal de REPLI (« c'est quoi ton nom… »), le même pour tous
// Les deux prises fixes se (re)génèrent depuis l'interface /api/welcome :
// 5 prises Fish Audio, on écoute, on choisit. Seul le prénom est refait par fan.
// Déclenché par le webhook OnlyFansAPI « subscriptions.new » (api/of-webhook.ts).
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_ID, modelByKey } from "./config.js";
import { fanFirstName } from "./fan-name.js";
import { generateVoice } from "./fish.js";
import { requestsThisMonth, sendChatMessage, uploadMedia } from "./onlyfans.js";
import { extractNameAudio, joinFixedAndName } from "./ppv-voice.js";
import { getRedis } from "./redis.js";
import { ffmpegBinary, run } from "./video.js";

/** La seule modèle branchée au vocal de bienvenue pour l'instant */
export const WELCOME_MODEL = "sienna";

export type TakeKind = "fixed" | "fallback";
export const TAKE_COUNT = 5;

export interface WelcomeSettings {
  enabled: boolean;
  /** Identifiant du compte OF chez OnlyFansAPI (acct_…) */
  accountId: string;
  /** Partie fixe, dite APRÈS le prénom (tags Fish acceptés au début) */
  fixedText: string;
  /** Vocal complet quand le pseudo est illisible */
  fallbackText: string;
  /** Petit texte envoyé avec le vocal (vide = vocal seul) */
  caption: string;
  /** Attente aléatoire avant l'envoi, en secondes (max 30) */
  delayMax: number;
}

export const DEFAULT_SETTINGS: WelcomeSettings = {
  enabled: false,
  accountId: "",
  fixedText: "[soft tone] Bienvenue dans mon univers… alors, quoi de neuf ?",
  fallbackText:
    "[soft tone] Bienvenue dans mon univers ! C'est quoi ton nom ? Parce que je peux pas lire ton pseudo.",
  caption: "",
  delayMax: 20,
};

/** Forfait OnlyFansAPI : requêtes par mois, et seuil où l'on coupe tout */
export const MONTHLY_LIMIT = Number(process.env.ONLYFANS_MONTHLY_LIMIT) || 20_000;
export const STOP_AT = Math.floor(MONTHLY_LIMIT * 0.9);

/** Prise choisie, gardée avec le texte d'où elle vient */
export interface ChosenTake {
  text: string;
  audio: string; // MP3 base64
  at: string;
}

export interface WelcomeLog {
  at: string;
  fan: string;
  display: string;
  username: string;
  /** Prénom prononcé ("" = vocal de repli) */
  name: string;
  ok: boolean;
  error?: string;
}

// ── Réglages ────────────────────────────────────────────────────────────────

const cfgKey = `welcome:cfg:${WELCOME_MODEL}`;
const takeKey = (kind: TakeKind) => `welcome:take:${WELCOME_MODEL}:${kind}`;
const candKey = (kind: TakeKind, i: number) => `welcome:cand:${WELCOME_MODEL}:${kind}:${i}`;

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as T;
}

export async function getWelcomeSettings(): Promise<WelcomeSettings> {
  const cfg = parse<Partial<WelcomeSettings>>(await getRedis().get(cfgKey));
  return { ...DEFAULT_SETTINGS, ...(cfg ?? {}) };
}

export async function saveWelcomeSettings(s: Partial<WelcomeSettings>): Promise<void> {
  const cur = await getWelcomeSettings();
  const clean: WelcomeSettings = {
    enabled: Boolean(s.enabled ?? cur.enabled),
    accountId: String(s.accountId ?? cur.accountId).trim(),
    fixedText: String(s.fixedText ?? cur.fixedText).trim().slice(0, 300) || DEFAULT_SETTINGS.fixedText,
    fallbackText: String(s.fallbackText ?? cur.fallbackText).trim().slice(0, 300) || DEFAULT_SETTINGS.fallbackText,
    caption: String(s.caption ?? cur.caption).trim().slice(0, 500),
    delayMax: Math.max(0, Math.min(30, Number(s.delayMax ?? cur.delayMax) || 0)),
  };
  await getRedis().set(cfgKey, JSON.stringify(clean));
}

export async function getChosenTake(kind: TakeKind): Promise<ChosenTake | null> {
  return parse<ChosenTake>(await getRedis().get(takeKey(kind)));
}

// ── Prises fixes : générer 5, écouter, choisir ─────────────────────────────

export function voiceId(): string {
  const m = modelByKey(WELCOME_MODEL);
  if (!m) throw new Error(`Modèle ${WELCOME_MODEL} absente de lib/config.ts`);
  return m.referenceId;
}

/** Génère 5 prises du texte (gardées 24 h) et les renvoie en base64 */
export async function generateTakes(kind: TakeKind, text: string): Promise<string[]> {
  const clean = text.trim();
  if (!clean) throw new Error("Texte vide.");
  const takes = await Promise.all(
    Array.from({ length: TAKE_COUNT }, () => generateVoice(clean, voiceId()))
  );
  const r = getRedis();
  const b64 = takes.map((t) => t.toString("base64"));
  await Promise.all(
    b64.map((audio, i) => r.set(candKey(kind, i), JSON.stringify({ text: clean, audio }), { ex: 24 * 3600 }))
  );
  return b64;
}

/** Installe la prise n° i (parmi les 5 dernières générées) */
export async function chooseTake(kind: TakeKind, i: number): Promise<void> {
  const cand = parse<{ text: string; audio: string }>(await getRedis().get(candKey(kind, i)));
  if (!cand) throw new Error("Prise expirée : régénère les 5 prises.");
  const chosen: ChosenTake = { ...cand, at: new Date().toISOString() };
  await getRedis().set(takeKey(kind), JSON.stringify(chosen));
}

// ── Assemblage du vocal d'un fan ───────────────────────────────────────────

/** Tags Fish du début de la partie fixe (« [soft tone] »), repris devant le prénom */
function leadingTags(text: string): string {
  return text.match(/^(\s*\[[^\]]*\]\s*)+/)?.[0].trim() ?? "";
}

/** Les premiers mots de la partie fixe : contexte court pour bien intoner le prénom */
function shortContext(fixedText: string): string {
  const body = fixedText.replace(/^(\s*\[[^\]]*\]\s*)+/, "");
  return body.split(/\s+/).slice(0, 4).join(" ").replace(/[,;:….!?]+$/, "");
}

/** Vitesse du vocal final (x1.1 : à vitesse normale elle semblait « bourrée », Teva 07/10/2026). Hauteur de voix conservée. */
export const WELCOME_SPEED = Number(process.env.WELCOME_SPEED) || 1.1;

async function toMp3(audio: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "welc-"));
  try {
    const inp = join(dir, "in.audio");
    const out = join(dir, "out.mp3");
    await writeFile(inp, audio);
    const r = await run(await ffmpegBinary(), [
      "-y", "-hide_banner", "-i", inp, "-af", `atempo=${WELCOME_SPEED}`, "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", out,
    ]);
    if (r.code !== 0) throw new Error(`conversion mp3 : ${r.stderr.slice(-300)}`);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Le vocal complet pour un pseudo : prénom + partie fixe, ou vocal de repli.
 * Sert à l'envoi réel ET au bouton « Tester » de l'interface.
 */
export async function buildWelcomeVoice(
  displayName: string,
  username = ""
): Promise<{ name: string; mp3: Buffer }> {
  const name = await fanFirstName(displayName, username);
  return { name, mp3: await voiceForName(name, name ? await getChosenTake("fixed") : await getChosenTake("fallback")) };
}

/** Prénom + prise fixe, ou (prénom vide) la prise de repli telle quelle. MP3. */
export async function voiceForName(name: string, take: ChosenTake | null): Promise<Buffer> {
  if (!name) {
    if (!take) throw new Error("Aucune prise « pseudo illisible » choisie dans l'interface.");
    return toMp3(Buffer.from(take.audio, "base64"));
  }
  const fixed = take;
  if (!fixed) throw new Error("Aucune prise de la partie fixe choisie dans l'interface.");
  const tags = leadingTags(fixed.text);
  const lead = tags ? `${tags} ` : "";
  // Le clone dit « Alex… bienvenue dans mon » pour une intonation naturelle,
  // puis on ne garde que le prénom. Repli : le prénom dit seul.
  const sentence = await generateVoice(`${lead}${name}… ${shortContext(fixed.text)}`, voiceId());
  const nameAudio =
    (await extractNameAudio(sentence, "before")) ?? (await generateVoice(`${lead}${name}…`, voiceId()));
  const line = await joinFixedAndName(Buffer.from(fixed.audio, "base64"), nameAudio, "before");
  return toMp3(line);
}

// ── Envoi à un nouvel abonné ───────────────────────────────────────────────

export async function readWelcomeLog(): Promise<WelcomeLog[]> {
  const rows = await getRedis().lrange<string | WelcomeLog>("welcome:log", 0, 99);
  return rows.map((r) => parse<WelcomeLog>(r)!);
}

async function addLog(entry: WelcomeLog): Promise<void> {
  const r = getRedis();
  await r.lpush("welcome:log", JSON.stringify(entry));
  await r.ltrim("welcome:log", 0, 199);
}

async function alertAdmin(message: string): Promise<void> {
  if (!process.env.BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: ADMIN_ID, text: message }),
  }).catch(() => {});
}

export async function handleNewSub(
  accountId: string,
  fanId: string,
  displayName: string,
  username = ""
): Promise<void> {
  const s = await getWelcomeSettings();
  if (!s.enabled || !s.accountId || s.accountId !== accountId) return;

  // Un seul vocal de bienvenue par fan, même s'il se réabonne
  const sentKey = `welcome:sent:${accountId}:${fanId}`;
  if ((await getRedis().set(sentKey, "1", { nx: true })) !== "OK") return;

  const log: WelcomeLog = {
    at: new Date().toISOString(),
    fan: fanId,
    display: displayName,
    username,
    name: "",
    ok: false,
  };
  try {
    const used = await requestsThisMonth();
    if (used >= STOP_AT) {
      throw new Error(`Quota OnlyFansAPI presque atteint (${used}/${MONTHLY_LIMIT}) : envoi bloqué.`);
    }
    const { name, mp3 } = await buildWelcomeVoice(displayName, username);
    log.name = name;
    if (s.delayMax > 0) await new Promise((r) => setTimeout(r, Math.random() * s.delayMax * 1000));
    const mediaId = await uploadMedia(accountId, mp3, "voice.mp3");
    await sendChatMessage(accountId, fanId, s.caption, [mediaId]);
    log.ok = true;
  } catch (err) {
    log.error = String((err as Error)?.message ?? err).slice(0, 300);
    // Échec : on libère le fan pour pouvoir le renvoyer depuis l'interface
    await getRedis().del(sentKey);
    await alertAdmin(`⚠️ Vocal de bienvenue non envoyé (fan ${displayName || username || fanId}) : ${log.error}`);
  }
  await addLog(log);
}
