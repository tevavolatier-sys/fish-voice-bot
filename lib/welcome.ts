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
import { enroll, markSent, type AbTest } from "./ab.js";
import { getSelfieSettings, makeSelfie } from "./selfie.js";
import { ADMIN_ID, modelByKey } from "./config.js";
import { fanFirstName } from "./fan-name.js";
import { generateVoice } from "./fish.js";
import { creditsCapReached, requestsThisMonth, sendChatMessage, uploadMedia } from "./onlyfans.js";
import { ACCOUNTS, SIENNA, accountByAcct, scoped, tagOf, type OfAccount } from "./accounts.js";
import { EFFECT_PRESETS, isEffectKey, roomVoiceSameLevel, type RoomParams } from "./ppv.js";
import { audioSeconds, extractNameAudio, joinFixedAndName } from "./ppv-voice.js";
import { defaultSettings, voiceOpts } from "./ppv-settings.js";
import { getRedis } from "./redis.js";
import { ffmpegBinary, run } from "./video.js";

/** Modèle historique du vocal de bienvenue (les autres comptes : lib/accounts.ts) */
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
  /** Au-delà de ce délai après l'abonnement, on n'envoie PLUS (Teva : 2 min) */
  maxDelaySec: number;
  /** Test A/B : un abonné sur deux ne reçoit PAS le vocal (lib/ab.ts) */
  abEnabled: boolean;
  /** Test en cours (« abc » ⅓ vocal / ⅓ rien / ⅓ selfie, ou « v90 » 90 % vocal / 10 % rien) */
  abTest: AbTest;
  /** Bascule automatique vers « v90 » à cette date (ms), 0 = pas de bascule prévue */
  abSwitchAt: number;
  /** 1er vocal envoyé au hasard entre ces deux délais après l'abonnement (s) — Teva 14/10 : 30-60 s */
  sendMinSec: number;
  sendMaxSec: number;
  /** Vocal de relance (« Netflix », vrai enregistrement de Sienna) envoyé juste après le 1er */
  followUpEnabled: boolean;
  /** Écart entre le 1er vocal et la relance (s), au hasard entre min et max — Teva : 5-6 s */
  followUpMinSec: number;
  followUpMaxSec: number;
  /** Texte de la relance générée par Fish (comptes sans vrai enregistrement : Lena, Jade) */
  followUpText: string;
}

/** Vrais enregistrements de Sienna (assets/vocaux) : relance Netflix et pseudo illisible */
export const REAL_FOLLOWUP = "2_netflix_Sienna-76609.mp3";
export const REAL_UNREADABLE = "3_pseudo_illisible_Sienna-61830.mp3";
export async function realAudio(file: string): Promise<Buffer> {
  return readFile(join(process.cwd(), "assets", "vocaux", file));
}

/** Test qui reçoit les nouveaux abonnés maintenant (la bascule programmée s'applique d'elle-même) */
export function currentAbTest(s: WelcomeSettings, now = Date.now()): AbTest {
  return s.abSwitchAt && now >= s.abSwitchAt ? "v90" : s.abTest;
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
  maxDelaySec: 120,
  abEnabled: false,
  abTest: "abc",
  abSwitchAt: 0,
  sendMinSec: 30,
  sendMaxSec: 60,
  followUpEnabled: true,
  followUpMinSec: 5,
  followUpMaxSec: 6,
  followUpText: "",
};

/**
 * Textes par langue. FR = Sienna (inchangé). DE (Lena) et EN (Jade) : même ton, chaud et joueur.
 * Les consignes de jeu entre crochets restent en anglais (Fish les lit comme des indications).
 */
const DIRECTION_1 = "[Young woman, relaxed on the couch, close to the mic, reading his name off her screen for the first time, a small smile]";
export const WELCOME_TEXTS: Record<OfAccount["lang"], { line: (name: string) => string; linePreview: string; fixed: (model: string) => string; fallback: string; followUp: string }> = {
  fr: {
    line: (name) => `${DIRECTION_1} Coucou ${name}… [a little warmer, smiling, gently cheerful, a light lift on the word page] Bienvenue sur ma page !`,
    linePreview: "Coucou {prénom}… Bienvenue sur ma page !",
    fixed: (m) => `[soft tone] Moi c'est ${m}, bienvenuuue !`,
    fallback: "[soft tone] Bienvenue dans mon univers ! C'est quoi ton nom ? Parce que je peux pas lire ton pseudo.",
    followUp: "",
  },
  de: {
    line: (name) => `${DIRECTION_1} Hey ${name}… [a little warmer, smiling, gently cheerful, a light lift on the word Seite] Willkommen auf meiner Seite!`,
    linePreview: "Hey {Vorname}… Willkommen auf meiner Seite!",
    fixed: (m) => `[soft tone] Ich bin ${m}, willkommen!`,
    fallback: "[soft tone] Willkommen in meiner Welt! Wie heißt du eigentlich? Ich kann deinen Nutzernamen nämlich nicht lesen.",
    followUp: "[relaxed, playful, a little smile] Ich wollte grad eigentlich was auf Netflix anmachen… aber ehrlich gesagt quatsch ich lieber mit dir. Was machst du gerade?",
  },
  en: {
    line: (name) => `${DIRECTION_1} Hey ${name}… [a little warmer, smiling, gently cheerful, a light lift on the word page] Welcome to my page!`,
    linePreview: "Hey {name}… Welcome to my page!",
    fixed: (m) => `[soft tone] I'm ${m}, welcome!`,
    fallback: "[soft tone] Welcome to my world! So what's your name? Cause I honestly can't read your username, haha.",
    followUp: "[relaxed, playful, a little smile] I was literally about to put something on Netflix… but honestly, I'd rather talk to you. What are you up to?",
  },
};

/** Réglages par défaut du compte : Sienna inchangée ; Lena/Jade désactivées, test v90, textes traduits */
export function defaultWelcomeSettings(a: OfAccount = SIENNA): WelcomeSettings {
  if (a.legacy) return DEFAULT_SETTINGS;
  const t = WELCOME_TEXTS[a.lang];
  return { ...DEFAULT_SETTINGS, enabled: false, accountId: a.acct, abTest: "v90", fixedText: t.fixed(a.modelName), fallbackText: t.fallback, followUpText: t.followUp };
}

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
  /** sent = envoyé · late = trop tard, pas envoyé · error = échec · control = sans vocal (test A/B) */
  status?: "sent" | "late" | "error" | "control";
  /** Secondes entre l'abonnement et l'envoi (ou l'abandon) */
  elapsedSec?: number;
  /** Renvoi manuel depuis l'interface */
  manual?: boolean;
  /** Selfie avec le prénom joint : par l'IA ou en texte (secours) */
  selfie?: "ai" | "text";
  selfieError?: string;
  /** Remarque de la génération (ex. 2e essai car prénom coupé) */
  selfieNote?: string;
  /** Vocal de relance (Netflix) envoyé, ou l'erreur */
  followUp?: boolean;
  followUpError?: string;
}

// ── Réglages ────────────────────────────────────────────────────────────────

// Clés par compte (pour Sienna : exactement les clés d'origine, « sienna » = WELCOME_MODEL)
const cfgKey = (a: OfAccount) => `welcome:cfg:${a.key}`;
const takeKey = (kind: TakeKind, a: OfAccount) => `welcome:take:${a.key}:${kind}`;
const candKey = (kind: TakeKind, i: number, a: OfAccount) => `welcome:cand:${a.key}:${kind}:${i}`;
const logKey = (a: OfAccount) => scoped("welcome:log", a);

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as T;
}

export async function getWelcomeSettings(a: OfAccount = SIENNA): Promise<WelcomeSettings> {
  const cfg = parse<Partial<WelcomeSettings>>(await getRedis().get(cfgKey(a)));
  return { ...defaultWelcomeSettings(a), ...(cfg ?? {}) };
}

/** Compte d'un acct_… reçu par webhook : registre, ou le compte enregistré dans les réglages de Sienna */
export async function resolveAccount(acct: string): Promise<OfAccount | null> {
  if (!acct) return null;
  const a = accountByAcct(acct);
  if (a) return a;
  return (await getWelcomeSettings(SIENNA)).accountId === acct ? SIENNA : null;
}

/** acct_… effectif du compte (celui des réglages, sinon celui du registre) */
export async function accountIdOf(a: OfAccount): Promise<string> {
  return (await getWelcomeSettings(a)).accountId || a.acct;
}

export async function saveWelcomeSettings(s: Partial<WelcomeSettings>, a: OfAccount = SIENNA): Promise<void> {
  const cur = await getWelcomeSettings(a);
  const def = defaultWelcomeSettings(a);
  const clean: WelcomeSettings = {
    enabled: Boolean(s.enabled ?? cur.enabled),
    accountId: String(s.accountId ?? cur.accountId).trim(),
    fixedText: String(s.fixedText ?? cur.fixedText).trim().slice(0, 300) || def.fixedText,
    fallbackText: String(s.fallbackText ?? cur.fallbackText).trim().slice(0, 300) || def.fallbackText,
    caption: String(s.caption ?? cur.caption).trim().slice(0, 500),
    delayMax: Math.max(0, Math.min(30, Number(s.delayMax ?? cur.delayMax) || 0)),
    maxDelaySec: Math.max(10, Math.min(3600, Number(s.maxDelaySec ?? cur.maxDelaySec) || 120)),
    abEnabled: Boolean(s.abEnabled ?? cur.abEnabled),
    abTest: s.abTest === "v90" || s.abTest === "abc" ? s.abTest : cur.abTest,
    abSwitchAt: Math.max(0, Number(s.abSwitchAt ?? cur.abSwitchAt) || 0),
    sendMinSec: Math.max(0, Math.min(110, Number(s.sendMinSec ?? cur.sendMinSec) || 0)),
    sendMaxSec: Math.max(0, Math.min(110, Number(s.sendMaxSec ?? cur.sendMaxSec) || 0)),
    followUpEnabled: Boolean(s.followUpEnabled ?? cur.followUpEnabled),
    followUpMinSec: Math.max(0, Math.min(60, Number(s.followUpMinSec ?? cur.followUpMinSec) || 0)),
    followUpMaxSec: Math.max(0, Math.min(60, Number(s.followUpMaxSec ?? cur.followUpMaxSec) || 0)),
    followUpText: String(s.followUpText ?? cur.followUpText ?? "").trim().slice(0, 400) || def.followUpText,
  };
  await getRedis().set(cfgKey(a), JSON.stringify(clean));
}

export async function getChosenTake(kind: TakeKind, a: OfAccount = SIENNA): Promise<ChosenTake | null> {
  return parse<ChosenTake>(await getRedis().get(takeKey(kind, a)));
}

// ── Prises fixes : générer 5, écouter, choisir ─────────────────────────────

export function voiceId(a: OfAccount = SIENNA): string {
  const m = modelByKey(a.voiceKey);
  if (!m) throw new Error(`Modèle ${a.voiceKey} absente de lib/config.ts`);
  return m.referenceId;
}

/** Génère 5 prises du texte (gardées 24 h) et les renvoie en base64 */
export async function generateTakes(kind: TakeKind, text: string, a: OfAccount = SIENNA): Promise<string[]> {
  const clean = text.trim();
  if (!clean) throw new Error("Texte vide.");
  const takes = await Promise.all(
    Array.from({ length: TAKE_COUNT }, () => generateVoice(clean, voiceId(a)))
  );
  const r = getRedis();
  const b64 = takes.map((t) => t.toString("base64"));
  await Promise.all(
    b64.map((audio, i) => r.set(candKey(kind, i, a), JSON.stringify({ text: clean, audio }), { ex: 24 * 3600 }))
  );
  return b64;
}

/** Installe la prise n° i (parmi les 5 dernières générées) */
export async function chooseTake(kind: TakeKind, i: number, a: OfAccount = SIENNA): Promise<void> {
  const cand = parse<{ text: string; audio: string }>(await getRedis().get(candKey(kind, i, a)));
  if (!cand) throw new Error("Prise expirée : régénère les 5 prises.");
  const chosen: ChosenTake = { ...cand, at: new Date().toISOString() };
  await getRedis().set(takeKey(kind, a), JSON.stringify(chosen));
}

/** Vrai enregistrement de la modèle à la place d'une prise Fish (text = ce qu'elle dit) */
export async function uploadTake(kind: TakeKind, text: string, audioB64: string, a: OfAccount = SIENNA): Promise<void> {
  const chosen: ChosenTake = { text, audio: audioB64, at: new Date().toISOString() };
  await getRedis().set(takeKey(kind, a), JSON.stringify(chosen));
}

/** Modèle Fish des phrases jouées (Drama 3 par défaut) */
const lineModel = () => process.env.WELCOME_LINE_MODEL?.trim() || "drama-3";

/**
 * Phrase complète générée une fois puis gardée (MP3 prêt à envoyer), refaite si le texte change.
 * Sert aux comptes sans vrais enregistrements (Lena, Jade) : vocal « pseudo illisible » et relance.
 */
async function cachedLine(a: OfAccount, kind: "fallback" | "followup", text: string): Promise<Buffer> {
  const clean = text.trim();
  if (!clean) throw new Error(`Texte ${kind === "fallback" ? "« pseudo illisible »" : "de relance"} vide.`);
  const k = `welcome:gen:${a.key}:${kind}`;
  const hit = parse<{ text: string; audio: string }>(await getRedis().get(k));
  if (hit && hit.text === clean) return Buffer.from(hit.audio, "base64");
  const mp3 = await toMp3(await generateVoice(clean, voiceId(a), { model: lineModel() }));
  await getRedis().set(k, JSON.stringify({ text: clean, audio: mp3.toString("base64") }));
  return mp3;
}

/** Vocal « pseudo illisible » du compte (MP3) : vrai vocal de Sienna, sinon prise choisie, sinon généré */
export async function unreadableAudio(a: OfAccount = SIENNA, s?: WelcomeSettings): Promise<Buffer> {
  if (a.legacy) return realAudio(REAL_UNREADABLE);
  const take = await getChosenTake("fallback", a);
  if (take) return toMp3(Buffer.from(take.audio, "base64"));
  return cachedLine(a, "fallback", (s ?? (await getWelcomeSettings(a))).fallbackText);
}

/** Vocal de relance du compte (MP3) : vrai vocal « Netflix » de Sienna, sinon généré dans la langue du compte */
export async function followUpAudio(a: OfAccount = SIENNA, s?: WelcomeSettings): Promise<Buffer> {
  if (a.legacy) return realAudio(REAL_FOLLOWUP);
  return cachedLine(a, "followup", (s ?? (await getWelcomeSettings(a))).followUpText);
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

/** Retire les silences au début et à la fin d'un audio (WAV mono). */
async function trimSilence(audio: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "trim-"));
  try {
    const inp = join(dir, "in.audio");
    const out = join(dir, "out.wav");
    await writeFile(inp, audio);
    const r = await run(await ffmpegBinary(), [
      "-y", "-hide_banner", "-i", inp,
      "-af", "silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.03,areverse,silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.05,areverse",
      "-ac", "1", "-c:a", "pcm_s16le", out,
    ]);
    if (r.code !== 0) throw new Error(`trim : ${r.stderr.slice(-300)}`);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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
  username = "",
  a: OfAccount = SIENNA
): Promise<{ name: string; mp3: Buffer }> {
  const name = await fanFirstName(displayName, username);
  if (!a.legacy) return { name, mp3: name ? await voiceForName(name, null, a) : await unreadableAudio(a) };
  return { name, mp3: await voiceForName(name, name ? await getChosenTake("fixed") : await getChosenTake("fallback")) };
}

/** Prénom + prise fixe, ou (prénom vide) la prise de repli telle quelle. MP3. */
export async function voiceForName(name: string, take: ChosenTake | null, a: OfAccount = SIENNA): Promise<Buffer> {
  if (!name) {
    if (!take) throw new Error("Aucune prise « pseudo illisible » choisie dans l'interface.");
    return toMp3(Buffer.from(take.audio, "base64"));
  }
  // Mode par défaut depuis le 14/10/2026 (tests à l'aveugle de Teva) : UNE phrase complète Drama 3,
  // « Coucou {prénom}… Bienvenue sur ma page ! », avec consignes de jeu. WELCOME_LINE_MODE=fixed → ancien mode.
  // Lena et Jade : toujours la phrase complète, dans leur langue (pas de prise fixe enregistrée)
  if (!a.legacy || (process.env.WELCOME_LINE_MODE?.trim() || "drama") === "drama") {
    const text = WELCOME_TEXTS[a.lang].line(name);
    return toMp3(await generateVoice(text, voiceId(a), { model: lineModel() }));
  }
  const fixed = take;
  if (!fixed) throw new Error("Aucune prise de la partie fixe choisie dans l'interface.");
  const tags = leadingTags(fixed.text);
  const lead = tags ? `${tags} ` : "";
  // Mode par défaut (07/10/2026, après essais) : Fish dit « Enchantée Alex… » en UNE
  // phrase courte et naturelle, sans découpage ; une seule couture avec le vrai
  // « moi c'est Sienna ». WELCOME_INTRO_MODE=real → ancien mode (vrai « Enchantée » + prénom découpé).
  if ((process.env.WELCOME_INTRO_MODE?.trim() || "fish") !== "real") {
    const hello = await generateVoice(`${lead}Enchantée ${name}…`, voiceId(), voiceOpts(defaultSettings()));
    const trimmed = await trimSilence(hello);
    return toMp3(await joinFixedAndName(Buffer.from(fixed.audio, "base64"), trimmed, "before", 0.12, 0));
  }
  const intro = await getRedis().get<string>(scoped("welcome:intro", a));
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
  // Le prénom Fish sonnait « IA » entre les deux vrais enregistrements (07/10/2026) :
  // on le passe dans une pièce (même moteur que le PPV) pour lui donner l'air
  // d'avoir été enregistré au même endroit, et on ne le met plus en avant (-1 dB).
  const roomKey = process.env.WELCOME_NAME_ROOM?.trim() || "dry"; // la pièce sur le prénom seul rendait pire (07/10)
  if (isEffectKey(roomKey) && roomKey !== "dry") {
    nameAudio = await roomVoiceSameLevel(nameAudio, EFFECT_PRESETS[roomKey].params).catch(() => nameAudio!);
  }
  const line = await joinFixedAndName(Buffer.from(fixed.audio, "base64"), nameAudio, "before", 0.12, -1);
  if (!intro) return toMp3(line);
  // « Enchantée » (vrai enregistrement) collé devant, quasi sans pause
  return toMp3(await joinFixedAndName(line, Buffer.from(intro, "base64"), "before", 0.04));
}

// ── Envoi à un nouvel abonné ───────────────────────────────────────────────

export async function readWelcomeLog(a: OfAccount = SIENNA): Promise<WelcomeLog[]> {
  const rows = await getRedis().lrange<string | WelcomeLog>(logKey(a), 0, 99);
  return rows.map((r) => parse<WelcomeLog>(r)!);
}

async function addLog(entry: WelcomeLog, a: OfAccount): Promise<void> {
  const r = getRedis();
  await r.lpush(logKey(a), JSON.stringify(entry));
  await r.ltrim(logKey(a), 0, 199);
}

/** Comptes dont la bienvenue est activée — Sienna toujours incluse (comportement d'origine) */
export async function activeWelcomeAccounts(): Promise<OfAccount[]> {
  const out: OfAccount[] = [];
  for (const a of ACCOUNTS) if (a.legacy || (await getWelcomeSettings(a)).enabled) out.push(a);
  return out;
}

/** Plafond journalier de crédits atteint : alerte Telegram une seule fois par jour */
export async function alertCapOnce(used: number, cap: number): Promise<void> {
  const k = `ofapi:capalert:${new Date().toISOString().slice(0, 10)}`;
  if ((await getRedis().set(k, "1", { nx: true, ex: 2 * 24 * 3600 })) !== "OK") return;
  await alertAdmin(`⛔ Plafond journalier OnlyFansAPI atteint (${used}/${cap} crédits aujourd'hui, tous comptes) : vocaux de bienvenue et PPV auto arrêtés jusqu'à minuit UTC. Réglable dans /api/welcome.`);
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
  username = "",
  opts: { subscribedAt?: number; force?: boolean; account?: OfAccount } = {}
): Promise<void> {
  const a = opts.account ?? (await resolveAccount(accountId));
  if (!a) return;
  const s = await getWelcomeSettings(a);
  if (!s.accountId || s.accountId !== accountId) return;
  if (!s.enabled && !opts.force) return;
  const since = opts.subscribedAt ?? Date.now();
  const elapsed = () => Math.round((Date.now() - since) / 10) / 100;
  // Budget de la fonction Vercel (300 s, vercel.json) : secondes qu'il reste pour finir proprement
  const t0 = Date.now();
  const left = () => 280 - (Date.now() - t0) / 1000;

  // Un seul vocal de bienvenue par fan, même s'il se réabonne (sauf renvoi manuel).
  // Verrou de 10 min d'abord ; rendu permanent seulement après l'envoi réussi, pour
  // qu'un fan perdu (fonction tuée par le délai Vercel) reste renvoyable.
  const sentKey = `welcome:sent:${accountId}:${fanId}`;
  if (!opts.force && (await getRedis().set(sentKey, "1", { nx: true, ex: 600 })) !== "OK") return;
  if (opts.force) await getRedis().set(sentKey, "1");

  const log: WelcomeLog = {
    at: new Date().toISOString(),
    fan: fanId,
    display: displayName,
    username,
    name: "",
    ok: false,
    status: "error",
    manual: opts.force || undefined,
  };
  const tooLate = () => !opts.force && elapsed() > s.maxDelaySec;
  // Test A/B/C : vocal seul / rien / vocal + selfie. Groupe « rien » → on n'envoie rien (sauf renvoi manuel)
  let withSelfie = true;
  if (s.abEnabled || opts.force) {
    const group = await enroll(accountId, fanId, since, displayName || username, currentAbTest(s));
    withSelfie = group === "selfie" || opts.force === true;
    if (group === "none" && !opts.force) {
      log.status = "control";
      log.ok = true;
      await addLog(log, a);
      return;
    }
  }
  try {
    if (tooLate()) throw new Error(`Trop tard : ${Math.round(elapsed())} s après l'abonnement (max ${s.maxDelaySec} s)`);
    const used = await requestsThisMonth();
    if (used >= STOP_AT) {
      throw new Error(`Quota OnlyFansAPI presque atteint (${used}/${MONTHLY_LIMIT}) : envoi bloqué.`);
    }
    // Plafond journalier GLOBAL de crédits (tous comptes + mass-dm-of), réglable dans l'interface
    const cap = await creditsCapReached();
    if (cap.over && !opts.force) {
      await alertCapOnce(cap.used, cap.cap).catch(() => {});
      throw new Error(`Plafond journalier OnlyFansAPI atteint (${cap.used}/${cap.cap} crédits aujourd'hui) : envoi bloqué.`);
    }
    const name = await fanFirstName(displayName, username);
    log.name = name;
    // Groupe « selfie » (Teva, 08/10) : le selfie SEUL avec son texte, pas de vocal ; si le selfie
    // échoue (pseudo illisible, IA en panne), le vocal part à la place pour que le fan ait quelque chose
    let selfie = withSelfie
      ? await makeSelfie(name, {}, a).catch((err) => {
          log.selfieError = String((err as Error)?.message ?? err).slice(0, 200);
          return null;
        })
      : null;
    if (withSelfie && !selfie && !log.selfieError) log.selfieError = name ? "selfie désactivé ou sans photo" : "pseudo illisible → vocal de repli";
    const mp3 = selfie ? null : name ? await voiceForName(name, await getChosenTake("fixed", a), a) : await unreadableAudio(a, s);
    if (selfie) {
      log.selfie = selfie.how;
      if (selfie.aiError) log.selfieError = selfie.aiError;
      if (selfie.note) log.selfieNote = selfie.note;
    }
    // Envoi au hasard entre sendMinSec et sendMaxSec après l'abonnement (Teva : 30-60 s),
    // jamais au-delà de la limite « trop tard » ni du budget de la fonction
    const lo = Math.min(s.sendMinSec, s.sendMaxSec), hi = Math.max(s.sendMinSec, s.sendMaxSec);
    const target = lo + Math.random() * (hi - lo);
    const wait = opts.force ? 0 : Math.max(0, Math.min(target - elapsed(), s.maxDelaySec - elapsed() - 15, left() - 30));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
    if (tooLate()) throw new Error(`Trop tard : ${Math.round(elapsed())} s après l'abonnement (max ${s.maxDelaySec} s)`);
    if (selfie) {
      const sc = await getSelfieSettings(a);
      const text = sc.caption.replace(/\{pr[ée]nom\}/gi, name);
      const mediaId = await uploadMedia(accountId, selfie.jpeg, "selfie.jpg");
      await sendChatMessage(accountId, fanId, text, [mediaId]);
    } else {
      const mediaId = await uploadMedia(accountId, mp3!, "voice.mp3");
      await sendChatMessage(accountId, fanId, s.caption, [mediaId]);
      // Relance « Netflix » (vrai vocal de Sienna), 5-6 s après ; un échec ici n'annule pas le 1er vocal
      if (s.followUpEnabled) {
        try {
          const flo = Math.min(s.followUpMinSec, s.followUpMaxSec), fhi = Math.max(s.followUpMinSec, s.followUpMaxSec);
          const gap = flo + Math.random() * (fhi - flo);
          const followId = await uploadMedia(accountId, await followUpAudio(a, s), "voice.mp3");
          if (gap > 0) await new Promise((r) => setTimeout(r, gap * 1000));
          await sendChatMessage(accountId, fanId, "", [followId]);
          log.followUp = true;
        } catch (err) {
          log.followUpError = String((err as Error)?.message ?? err).slice(0, 200);
        }
      }
    }
    log.ok = true;
    log.status = "sent";
    log.elapsedSec = elapsed();
    await getRedis().set(sentKey, "1"); // permanent : ce fan a eu son vocal
    // Groupe « selfie » qui a reçu le vocal de repli (IA en panne, pseudo illisible) : hors test,
    // sinon il fausserait la comparaison
    if (!(withSelfie && !selfie && !opts.force)) await markSent(accountId, fanId);
  } catch (err) {
    log.error = String((err as Error)?.message ?? err).slice(0, 300);
    log.elapsedSec = elapsed();
    if (log.error.startsWith("Trop tard")) {
      // Pas envoyé, et on n'enverra pas tout seul (le fan a déjà bougé) ; renvoi manuel possible
      log.status = "late";
      await addLog(log, a);
      return;
    }
    // Échec : on libère le fan pour pouvoir le renvoyer depuis l'interface
    await getRedis().del(sentKey);
    // Plafond atteint : signalé une seule fois par jour (alertCapOnce), pas une alerte par fan
    if (!log.error.startsWith("Plafond journalier")) await alertAdmin(`${tagOf(a)}⚠️ Vocal de bienvenue non envoyé (fan ${displayName || username || fanId}) : ${log.error}`);
  }
  await addLog(log, a);
}
