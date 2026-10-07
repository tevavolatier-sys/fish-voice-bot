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
import { roomVoiceSameLevel, type RoomParams } from "./ppv.js";
import { audioSeconds, extractNameAudio, joinFixedAndName } from "./ppv-voice.js";
import { defaultSettings, voiceOpts } from "./ppv-settings.js";
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
  // Partie fixe dite APRÈS le prénom. Devant : l'enregistrement « Enchantée » (Redis welcome:intro)
  fixedText: "[soft tone] Moi c'est Sienna, bienvenuuue !",
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

/** Vrai enregistrement de la modèle à la place d'une prise Fish (text = ce qu'elle dit) */
export async function uploadTake(kind: TakeKind, text: string, audioB64: string): Promise<void> {
  const chosen: ChosenTake = { text, audio: audioB64, at: new Date().toISOString() };
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
export const WELCOME_SPEED = Number(process.env.WELCOME_SPEED) || 1; // x1 : retour à la vitesse normale (Teva, 07/10/2026)

/**
 * Effet « vocal envoyé depuis un téléphone » (WELCOME_FX=off pour le couper).
 * Appliqué au vocal ENTIER, donc aux trois morceaux (vrai « Enchantée », prénom
 * Fish, vraie partie fixe) à la fois : même micro, même souffle de fond, même
 * compression → les coutures s'entendent moins et la voix Fish perd son côté
 * trop propre. Puis MP3 basse qualité, comme un vrai vocal.
 */
export const WELCOME_FX = (process.env.WELCOME_FX ?? "on").trim().toLowerCase() !== "off";

/**
 * Éloignement de la voix (0 = comme avant, choix de Teva ; 1 = « un peu plus éloigné »,
 * demandé par Teva le 07/10/2026, jusqu'à 3). Réglable sans code : WELCOME_DISTANCE.
 */
export const WELCOME_DISTANCE = Math.max(0, Math.min(3, Number(process.env.WELCOME_DISTANCE ?? 0) || 0));

/** La pièce autour du téléphone (même moteur que l'effet « Far » du bot PPV) ; l'EQ reste dans PHONE_FX */
function welcomeRoom(d: number): RoomParams {
  return {
    highpass: 20, lowpass: 20000, warmthDb: 0, presenceDb: 0, compression: 0,
    boomCutDb: -1.5 * d, // moins d'effet de proximité quand on s'éloigne
    reflections: 0.35 * d, // murs proches
    reverb: 0.08 * d, reverbSec: 0.45 + 0.15 * d, // traîne de la pièce
    width: 1,
  };
}

const PHONE_FX =
  // micro de téléphone : pas de graves, aigus coupés
  `highpass=f=140,lowpass=f=${7200 - 400 * WELCOME_DISTANCE},` +
  // compression typique des vocaux (la voix est toujours « devant »)
  "acompressor=threshold=0.15:ratio=3:attack=8:release=140:makeup=1.6," +
  // un peu de présence (2,8 kHz) comme une capsule de smartphone
  `equalizer=f=2800:width_type=o:width=1.5:g=${1.5 - 0.4 * WELCOME_DISTANCE}`;

function mp3Args(inp: string, out: string): string[] {
  const tempo = `atempo=${WELCOME_SPEED}`;
  if (!WELCOME_FX) {
    return ["-y", "-hide_banner", "-i", inp, "-af", tempo, "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", out];
  }
  // souffle de pièce très léger sous tout le vocal : plus de silences « morts » entre les morceaux
  const graph =
    // (mono d'abord : la pièce sort en stéréo ; plus loin = un peu moins fort devant le souffle)
    `[0:a]${tempo},aformat=sample_rates=48000:channel_layouts=mono,${PHONE_FX},volume=${-1.2 * WELCOME_DISTANCE}dB[v];` +
    `anoisesrc=color=pink:amplitude=0.0035:sample_rate=48000:seed=7[n];` +
    `[v][n]amix=inputs=2:duration=first:dropout_transition=0,volume=2[a]`; // le ffmpeg embarqué divise par 2 (pas d'option normalize) → on compense;
  return [
    "-y", "-hide_banner", "-i", inp, "-filter_complex", graph, "-map", "[a]",
    "-ac", "1", "-ar", "24000", "-c:a", "libmp3lame", "-b:a", "48k", out,
  ];
}

export async function toMp3(audio: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "welc-"));
  try {
    const inp = join(dir, "in.audio");
    const out = join(dir, "out.mp3");
    // D'abord la pièce (stéréo, même niveau), puis le micro de téléphone et le souffle
    const src = WELCOME_FX && WELCOME_DISTANCE > 0 ? await roomVoiceSameLevel(audio, welcomeRoom(WELCOME_DISTANCE)) : audio;
    await writeFile(inp, src);
    const r = await run(await ffmpegBinary(), mp3Args(inp, out));
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
  const intro = await getRedis().get<string>("welcome:intro");
  const tags = leadingTags(fixed.text);
  const lead = tags ? `${tags} ` : "";
  // Comme le bot PPV : le clone dit « Alex… moi c'est Sienna » en entier pour une
  // intonation naturelle, on ne garde que le prénom (1er bloc avant la pause), avec
  // les mêmes réglages de voix que le PPV. Repli : le prénom dit seul.
  // (Bug du 07/10/2026 : avec « Enchantée… » dans la phrase, Fish ne marquait pas
  // toujours la pause et le bloc gardé était « moi c'est Sienna » au lieu du prénom.)
  const opts = voiceOpts(defaultSettings());
  const sentence = await generateVoice(`${lead}${name}… ${shortContext(fixed.text)}`, voiceId(), opts);
  let nameAudio = await extractNameAudio(sentence, "before").catch(() => null);
  // Garde-fou : un prénom isolé ne peut pas durer plus que ~0,15 s par lettre (+0,35 s)
  if (nameAudio && (await audioSeconds(nameAudio).catch(() => 99)) > 0.35 + 0.15 * name.length) nameAudio = null;
  nameAudio ??= await generateVoice(`${lead}${name}…`, voiceId(), opts);
  const line = await joinFixedAndName(Buffer.from(fixed.audio, "base64"), nameAudio, "before", 0.12, 1);
  if (!intro) return toMp3(line);
  // « Enchantée » (vrai enregistrement) collé devant, quasi sans pause
  return toMp3(await joinFixedAndName(line, Buffer.from(intro, "base64"), "before", 0.04));
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
