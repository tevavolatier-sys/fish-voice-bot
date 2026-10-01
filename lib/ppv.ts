// 💰 PPV PERSONNALISÉ AU PRÉNOM DU FAN — commande /ppv <prénom>.
//
// Le bot génère 3 pistes avec la voix clonée de la modèle (Fish Audio) :
//   1. preview gratuite : « {prénom}… toi et moi, ça va être fou »
//      → vidéo fond noir (lib/video.ts)
//   2. vidéo payante 1 : « Hmmm… c'est chaud, toi et moi… {prénom} »
//      → posée au début de la 1re vidéo enregistrée par l'admin (/ppvadd)
//   3. vidéo payante 2 : soupirs et gémissements qui finissent sur le prénom
//      → posée pour se terminer juste avant la fin de la 2e vidéo enregistrée
// Rôles FIXES (pas de tirage au sort) : les autres vidéos du PPV sont déjà
// dans le Vault, sans prénom. L'image n'est PAS réencodée : seul le son est
// remixé (voix par-dessus, son d'origine baissé pendant qu'elle parle).

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegBinary, parseInputDuration, run } from "./video.js";

/** Modèle des vidéos PPV enregistrées par défaut (IMG_0585 = Sienna) */
export const PPV_DEFAULT_MODEL = "sienna";

// Textes, calages et effets : réglables depuis le bot (lib/ppv-settings.ts)

export type Placement =
  | { mode: "start"; at: number }
  | { mode: "end"; before: number };

const MAX_NAME = 20;

/**
 * Prénom du fan, nettoyé. Lettres (accents compris), espaces, tirets et
 * apostrophes seulement : pas de chiffres ni de [crochets] (qui seraient
 * lus comme des tags de jeu par Fish Audio). null si inutilisable.
 */
export function cleanFanName(input: string): string | null {
  const name = input.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > MAX_NAME) return null;
  if (!/^[\p{L}][\p{L} '’-]*$/u.test(name)) return null;
  // Première lettre en majuscule (« julien » → « Julien »), le reste tel quel
  return name.charAt(0).toLocaleUpperCase("fr-FR") + name.slice(1);
}

export function fillLine(line: string, name: string): string {
  return line.split("{name}").join(name);
}

/** Tire 2 vidéos DIFFÉRENTES parmi `count` (indices). */
export function pickTwo(count: number, random: () => number = Math.random): [number, number] {
  if (count < 2) throw new Error("Il faut au moins 2 vidéos");
  const a = Math.floor(random() * count);
  let b = Math.floor(random() * (count - 1));
  if (b >= a) b += 1;
  return [a, b];
}

/** Début (en s) de la voix dans une vidéo, sans jamais déborder de la fin. */
export function voiceStart(videoSec: number, voiceSec: number, place: Placement): number {
  const latest = Math.max(0, videoSec - voiceSec - 0.2);
  const wanted = place.mode === "start" ? place.at : videoSec - place.before - voiceSec;
  return Math.round(Math.min(latest, Math.max(0, wanted)) * 1000) / 1000;
}

// Dimensions de la vidéo d'après « ffmpeg -i » (« Video: hevc … 1920x1080 »)
export function parseVideoSize(stderr: string): { width: number; height: number } | null {
  const line = stderr.split("\n").find((l) => /Stream #\d+:\d+.*Video:/.test(l));
  const m = line?.match(/,\s*(\d{2,5})x(\d{2,5})[\s,]/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

// ── Rendu « dans la pièce » ──────────────────────────────────────────────
// Une voix collée telle quelle sonne « studio », trop proche et trop forte.
// Pour qu'elle semble captée par le micro de la caméra, à distance :
//   · niveau nettement plus bas,
//   · moins de basses (pas d'effet de proximité) et d'aigus (la distance),
//   · une petite pièce : premières réflexions + réverbération courte.
// Volume de la voix dans les vidéos payantes : 5 niveaux réglables depuis
// le bot (boutons sous chaque PPV). Valeur = niveau moyen visé pour la PARTIE
// FIXE une fois « dans la pièce » (dB). Le gain est CONSTANT et calculé sur
// la partie fixe seule : elle sonne exactement pareil pour tous les fans.
export const PPV_VOLUME_LEVELS: Record<number, { db: number; icon: string }> = {
  1: { db: -61, icon: "🔈" },
  2: { db: -55, icon: "🔉" },
  3: { db: -50, icon: "🔉" },
  4: { db: -45, icon: "🔊" },
  5: { db: -40, icon: "🔊" },
};
export const PPV_DEFAULT_VOLUME = 2;

export function ppvTargetDb(level?: number | null): number {
  return (PPV_VOLUME_LEVELS[level ?? PPV_DEFAULT_VOLUME] ?? PPV_VOLUME_LEVELS[PPV_DEFAULT_VOLUME]).db;
}

// ── Effets de voix (réglables depuis le bot) ──────────────────────────────
// Une voix de synthèse collée telle quelle se repère : son « studio », mono
// au centre, sans la couleur du micro. Chaque effet = une couleur de micro +
// une pièce STÉRÉO (son direct un peu décentré : les 2 micros de l'iPhone ne
// l'entendent pas au même instant, réflexions différentes à gauche et à
// droite). Le son d'origine de la vidéo n'est PAS baissé : une vraie pièce ne
// se tait pas. Le niveau est mesuré APRÈS l'effet, donc les 5 niveaux de
// volume restent comparables d'un effet à l'autre.
// Le son « boîte de conserve » vient surtout des réflexions TRÈS courtes
// (3 à 7 ms : elles creusent le spectre en peigne) et d'une bande étroite
// façon téléphone : les effets « naturels » les réduisent et gardent graves
// et aigus.
export interface RoomParams {
  highpass: number; // Hz : coupe les graves en dessous (20 = rien)
  lowpass: number; // Hz : adoucit les aigus au-dessus (20000 = rien)
  warmthDb: number; // dB vers 180 Hz : chaleur du bas-médium
  boomCutDb: number; // dB vers 250 Hz : retire l'effet de proximité
  presenceDb: number; // dB vers 2,5 kHz : présence « téléphone »
  compression: number; // 0 aucune · 1 douce · 2 moyenne · 3 forte
  reflections: number; // 0 … 1 : réflexions courtes sur les murs proches
  reverb: number; // niveau de la traîne de la pièce
  reverbSec: number; // s : longueur de la traîne
  width: number; // 0 (mono) … 1 : écart entre les 2 micros
}

export type EffectKey = "natural" | "bedroom" | "close" | "iphone" | "far" | "dry";

export const EFFECT_PRESETS: Record<
  EffectKey,
  { label: string; icon: string; about: string; params: RoomParams }
> = {
  natural: {
    label: "Natural",
    icon: "🎧",
    about: "real voice in the room, full sound, almost no tin can",
    params: {
      highpass: 80, lowpass: 12000, warmthDb: 1.5, boomCutDb: -1, presenceDb: 0.5,
      compression: 1, reflections: 0.2, reverb: 0.05, reverbSec: 0.4, width: 0.6,
    },
  },
  bedroom: {
    label: "Bedroom",
    icon: "🛏️",
    about: "a bit more room around her, still soft",
    params: {
      highpass: 90, lowpass: 10000, warmthDb: 1, boomCutDb: -1.5, presenceDb: 1,
      compression: 1, reflections: 0.35, reverb: 0.08, reverbSec: 0.5, width: 0.8,
    },
  },
  close: {
    label: "Close",
    icon: "💋",
    about: "right next to the mic, intimate, dry",
    params: {
      highpass: 70, lowpass: 14000, warmthDb: 2, boomCutDb: 0, presenceDb: -0.5,
      compression: 1, reflections: 0, reverb: 0.02, reverbSec: 0.3, width: 0.3,
    },
  },
  iphone: {
    label: "iPhone",
    icon: "📱",
    about: "filmed by the phone ~1.5 m away (the old sound)",
    params: {
      highpass: 130, lowpass: 7500, warmthDb: 0, boomCutDb: -3, presenceDb: 2.5,
      compression: 2, reflections: 1, reverb: 0.05, reverbSec: 0.25, width: 1,
    },
  },
  far: {
    label: "Far",
    icon: "🚪",
    about: "across the room, more distant",
    params: {
      highpass: 150, lowpass: 6500, warmthDb: -1, boomCutDb: -3, presenceDb: 1.5,
      compression: 2, reflections: 0.5, reverb: 0.12, reverbSec: 0.6, width: 1,
    },
  },
  dry: {
    label: "Dry",
    icon: "⚪",
    about: "no effect at all (only the volume)",
    params: {
      highpass: 20, lowpass: 20000, warmthDb: 0, boomCutDb: 0, presenceDb: 0,
      compression: 0, reflections: 0, reverb: 0, reverbSec: 0.1, width: 0,
    },
  },
};
export const EFFECT_KEYS = Object.keys(EFFECT_PRESETS) as EffectKey[];
export const DEFAULT_EFFECT: EffectKey = "natural";
export const isEffectKey = (v: unknown): v is EffectKey =>
  typeof v === "string" && (EFFECT_KEYS as string[]).includes(v);

const IR_RATE = 48_000;

function prng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Réponse impulsionnelle STÉRÉO de la pièce de l'effet (WAV 32 bits
 * flottants, 2 canaux). Déterministe.
 */
export function roomImpulseWav(p: RoomParams = EFFECT_PRESETS.iphone.params): Buffer {
  const len = Math.round(IR_RATE * (p.reverbSec + 0.08));
  const ch = [new Float32Array(len), new Float32Array(len)];
  const at = (ms: number) => Math.min(len - 1, Math.round((ms * IR_RATE) / 1000));
  const w = Math.max(0, Math.min(1, p.width));
  // Son direct (ajouté après le réglage de largeur, voir plus bas)
  const direct = () => {
    ch[0][at(0)] += 1;
    ch[1][at(0.2 * w)] += 0.85 + 0.15 * (1 - w);
  };
  if (w >= 1) direct();
  // Réflexions précoces (ms, gain) : sol, murs, plafond, meubles — différentes
  // pour chaque micro (c'est ce qui « place » la voix), toutes positives : un
  // mur renvoie le son sans l'inverser, et le mélange mono (haut-parleur de
  // téléphone) ne s'annule pas
  const early: [number, number][][] = [
    [[2.9, 0.5], [6.1, 0.38], [9.8, 0.3], [13.6, 0.24], [19.2, 0.18], [26.5, 0.13], [34.1, 0.09]],
    [[3.6, 0.46], [7.4, 0.36], [11.1, 0.28], [15.2, 0.22], [21.7, 0.17], [28.9, 0.12], [37.3, 0.08]],
  ];
  early.forEach((list, c) => list.forEach(([ms, g]) => (ch[c][at(ms)] += g * p.reflections)));
  // Traîne décorrélée entre les 2 canaux, assombrie
  const tau = p.reverbSec / 6.91;
  const start = at(12);
  [0x51ab3, 0x9e377].forEach((seed, c) => {
    const rnd = prng(seed);
    let lp = 0;
    for (let i = start; i < len; i++) {
      const t = (i - start) / IR_RATE;
      // Bruit « éclairci » (sans graves) : sinon la traîne grave domine et
      // différente à gauche/droite, elle s'annule en partie en mono
      const x = (rnd() * 2 - 1) * p.reverb * Math.exp(-t / tau);
      ch[c][i] += x - lp;
      lp += 0.05 * (x - lp);
    }
  });
  const fade = at(15);
  for (let i = 0; i < fade; i++) {
    ch[0][len - 1 - i] *= i / fade;
    ch[1][len - 1 - i] *= i / fade;
  }
  // Largeur < 1 : les 2 micros se ressemblent davantage (0 = mono au centre)
  if (w < 1) {
    const a = (1 + w) / 2;
    const b = (1 - w) / 2;
    for (let i = 0; i < len; i++) {
      const l = ch[0][i];
      const r = ch[1][i];
      ch[0][i] = a * l + b * r;
      ch[1][i] = a * r + b * l;
    }
    // Son direct NON mélangé : une copie décalée de lui-même creuserait le
    // spectre en peigne (le défaut « boîte de conserve »)
    direct();
  }

  const bytes = len * 2 * 4;
  const buf = Buffer.alloc(44 + bytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20); // IEEE float
  buf.writeUInt16LE(2, 22); // stéréo
  buf.writeUInt32LE(IR_RATE, 24);
  buf.writeUInt32LE(IR_RATE * 8, 28);
  buf.writeUInt16LE(8, 32);
  buf.writeUInt16LE(32, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < len; i++) {
    buf.writeFloatLE(ch[0][i], 44 + i * 8);
    buf.writeFloatLE(ch[1][i], 48 + i * 8);
  }
  return buf;
}

// Compression (le contrôle de gain automatique d'un téléphone), 0 → 3
const COMPRESSORS = [
  "",
  "acompressor=threshold=0.18:ratio=1.8:attack=15:release=200:makeup=1,",
  "acompressor=threshold=0.125:ratio=3:attack=10:release=150:makeup=1,",
  "acompressor=threshold=0.1:ratio=5:attack=5:release=120:makeup=1,",
];

const num = (x: number) => String(Math.round(x * 1000) / 1000);

// Voix → couleur du micro → pièce stéréo (sans réglage de niveau). Un réglage
// neutre (0 dB, 20 Hz, 20 kHz) n'ajoute pas de filtre du tout.
export function roomArgs(
  input: string,
  impulse: string,
  output: string,
  p: RoomParams = EFFECT_PRESETS.iphone.params
): string[] {
  const tail = Math.round(IR_RATE * (p.reverbSec + 0.1));
  const comp = COMPRESSORS[Math.max(0, Math.min(3, Math.round(p.compression)))];
  const eq =
    (p.highpass > 20 ? `highpass=f=${num(p.highpass)},` : "") +
    (p.lowpass < 20000 ? `lowpass=f=${num(p.lowpass)},` : "") +
    (p.warmthDb ? `bass=g=${num(p.warmthDb)}:f=180:width_type=o:width=1,` : "") +
    (p.boomCutDb ? `equalizer=f=250:width_type=o:width=1:g=${num(p.boomCutDb)},` : "") +
    (p.presenceDb ? `equalizer=f=2500:width_type=o:width=1.5:g=${num(p.presenceDb)},` : "");
  const graph =
    `[0:a]aresample=${IR_RATE},${comp}${eq}` +
    `apad=pad_len=${tail},pan=stereo|c0=c0|c1=c0[mono2];` +
    // gtype=-1 : la pièce est appliquée telle quelle (l'auto-gain du ffmpeg
    // embarqué écrasait le son direct sous la traîne)
    `[mono2][1:a]afir=gtype=-1,volume=-18dB[room]`;
  return [
    "-y", "-hide_banner", "-i", input, "-i", impulse,
    "-filter_complex", graph, "-map", "[room]", "-c:a", "pcm_s16le", output,
  ];
}

const meanDbOf = (stderr: string): number | null => {
  const m = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? Number(m[1]) : null;
};

/** Passe la voix dans l'effet ; renvoie le WAV et son niveau moyen. */
export async function roomVoice(
  audio: Buffer,
  p: RoomParams = EFFECT_PRESETS.iphone.params
): Promise<{ wav: Buffer; meanDb: number }> {
  const dir = await mkdtemp(join(tmpdir(), "room-"));
  try {
    const input = join(dir, "in.audio");
    const ir = join(dir, "room.wav");
    const out = join(dir, "voice-room.wav");
    await Promise.all([writeFile(input, audio), writeFile(ir, roomImpulseWav(p))]);
    const bin = await ffmpegBinary();
    const r = await run(bin, roomArgs(input, ir, out, p));
    if (r.code !== 0) throw new Error(`pièce: ${r.stderr.slice(-400)}`);
    const v = await run(bin, ["-hide_banner", "-i", out, "-af", "volumedetect", "-f", "null", "-"]);
    const meanDb = meanDbOf(v.stderr);
    if (meanDb === null) throw new Error("niveau de la voix illisible");
    return { wav: await readFile(out), meanDb };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Voix passée dans l'effet mais au MÊME niveau moyen qu'avant (preview fond
 * noir : on change la couleur, pas le volume). WAV stéréo.
 */
export async function roomVoiceSameLevel(audio: Buffer, p: RoomParams): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "roomlvl-"));
  try {
    const input = join(dir, "in.audio");
    const wet = join(dir, "wet.wav");
    const out = join(dir, "out.wav");
    await writeFile(input, audio);
    const bin = await ffmpegBinary();
    const [dry, room] = await Promise.all([
      run(bin, ["-hide_banner", "-i", input, "-af", "volumedetect", "-f", "null", "-"]),
      roomVoice(audio, p),
    ]);
    const before = meanDbOf(dry.stderr);
    if (before === null) throw new Error("niveau de la voix illisible");
    await writeFile(wet, room.wav);
    const gain = Math.max(-40, Math.min(40, before - room.meanDb));
    const r = await run(bin, [
      "-y", "-hide_banner", "-i", wet,
      "-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=0.95:level=false`,
      "-c:a", "pcm_s16le", out,
    ]);
    if (r.code !== 0) throw new Error(`niveau: ${r.stderr.slice(-300)}`);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function mixArgs(
  video: string,
  voiceRoom: string,
  output: string,
  gainDb: number,
  start: number,
  videoSec: number,
  hasAudio: boolean
): string[] {
  const delayMs = Math.round(start * 1000);
  // Gain CONSTANT (pas de normalisation dynamique) : la partie fixe garde
  // exactement la même forme d'un fan à l'autre.
  const voiceChain =
    `[1:a]aresample=${IR_RATE},volume=${gainDb.toFixed(2)}dB,` +
    `adelay=${delayMs}|${delayMs},apad[vo]`;
  // amix divise chaque entrée par 2 (ffmpeg embarqué de 2018, sans l'option
  // normalize) : « volume=2 » rétablit les niveaux. Le son d'origine n'est
  // pas baissé : une vraie pièce ne se tait pas.
  const graph = hasAudio
    ? `[0:a]aresample=${IR_RATE}[bg];${voiceChain};` +
      `[bg][vo]amix=inputs=2:duration=first,volume=2,alimiter=limit=0.95[a]`
    : `${voiceChain};[vo]alimiter=limit=0.95[a]`;
  return [
    "-y",
    "-hide_banner",
    "-i", video,
    "-i", voiceRoom,
    "-filter_complex", graph,
    "-map", "0:v:0",
    "-map", "[a]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "160k",
    "-t", videoSec.toFixed(3),
    "-movflags", "+faststart",
    output,
  ];
}

/**
 * Pose la voix dans la vidéo (image intacte, son remixé « dans la pièce »).
 * `refMeanDb` : niveau « dans la pièce » de la PARTIE FIXE seule (roomVoice) —
 * le gain est calé dessus, donc identique pour tous les fans. À défaut, calé
 * sur la phrase entière.
 */
export async function mixVoiceIntoVideo(
  video: Buffer,
  voice: Buffer,
  place: Placement,
  targetDb: number = ppvTargetDb(PPV_DEFAULT_VOLUME),
  refMeanDb?: number,
  /** Durée de la partie fixe + pause + prénom max : la phrase est calée sur
   *  la partie fixe, à un instant IDENTIQUE pour tous les fans (« end ») */
  anchorSec?: number,
  room: RoomParams = EFFECT_PRESETS.iphone.params
): Promise<{ video: Buffer; duration: number; width?: number; height?: number }> {
  const dir = await mkdtemp(join(tmpdir(), "ppv-"));
  const vIn = join(dir, "in.mp4");
  const aIn = join(dir, "voice-room.wav");
  const out = join(dir, "out.mp4");
  try {
    const [wet] = await Promise.all([roomVoice(voice, room), writeFile(vIn, video)]);
    await writeFile(aIn, wet.wav);
    const bin = await ffmpegBinary();
    const [pv, pa] = await Promise.all([
      run(bin, ["-hide_banner", "-i", vIn]),
      run(bin, ["-hide_banner", "-i", aIn]),
    ]);
    const videoSec = parseInputDuration(pv.stderr);
    const voiceSec = parseInputDuration(pa.stderr);
    if (!videoSec || !voiceSec) throw new Error("durée illisible (vidéo ou voix)");
    const hasAudio = /Stream #0:\d+.*Audio:/.test(pv.stderr);
    // « end » : calé sur la partie fixe (anchorSec), pas sur la phrase entière
    // — sinon un prénom plus long décalerait la partie fixe.
    const start =
      place.mode === "end" && anchorSec
        ? voiceStart(videoSec, Math.max(voiceSec, anchorSec), place)
        : voiceStart(videoSec, voiceSec, place);
    const gainDb = targetDb - (refMeanDb ?? wet.meanDb);
    const { code, stderr } = await run(
      bin,
      mixArgs(vIn, aIn, out, gainDb, start, videoSec, hasAudio)
    );
    if (code !== 0) throw new Error(`ffmpeg code ${code}: ${stderr.slice(-600)}`);
    const size = parseVideoSize(pv.stderr);
    return {
      video: await readFile(out),
      duration: Math.max(1, Math.round(videoSec)),
      ...(size ?? {}),
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
