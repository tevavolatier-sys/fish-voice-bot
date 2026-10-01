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

/** Les 3 phrases (fixes) ; {name} = prénom du fan. Tags = jeu de la voix. */
export const PPV_LINES = {
  preview: "[soft tone] {name}… [breath] toi et moi, ça va être fou.",
  paid1: "[soft tone] Hmmm… [breath] c'est chaud, toi et moi… {name}.",
  paid2: "[sighing] Hmmm… [breath] [groaning] mmmh… [panting] [sighing] {name}…",
} as const;

/** Où poser la voix dans chaque vidéo payante */
export const PPV_PLACEMENT = {
  paid1: { mode: "start", at: 1.5 },
  paid2: { mode: "end", before: 0.6 },
} as const;

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
export const PPV_ROOM = {
  loudness: -32, // LUFS de la voix avant la pièce (-14 = voix « studio », trop forte)
  highpass: 170, // Hz
  lowpass: 6000, // Hz
  dry: 0.8, // part de son direct
  wet: 0.2, // part de la pièce (plus = plus loin, plus d'écho)
  rt60: 0.3, // durée de la réverbération (s) : petite pièce mate
} as const;

const IR_RATE = 48_000;

/**
 * Réponse impulsionnelle d'une petite pièce (WAV mono 32 bits flottants) :
 * quelques réflexions précoces puis une queue de bruit qui décroît, assombrie.
 * Déterministe (même pièce à chaque fois).
 */
export function roomImpulseWav(rt60: number = PPV_ROOM.rt60): Buffer {
  const len = Math.round(IR_RATE * (rt60 + 0.1));
  const data = new Float32Array(len);
  data[0] = 1; // son direct
  const early: [number, number][] = [
    [7, 0.55], [11, -0.45], [17, 0.38], [23, -0.3], [31, 0.24], [41, -0.18],
  ];
  for (const [ms, g] of early) data[Math.round((ms * IR_RATE) / 1000)] += g;
  let seed = 0x2f6b9a1d;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const tau = rt60 / 6.91; // décroissance de 60 dB en rt60 secondes
  const tailStart = Math.round(0.012 * IR_RATE);
  let lp = 0;
  for (let i = tailStart; i < len; i++) {
    const t = (i - tailStart) / IR_RATE;
    const noise = (rnd() * 2 - 1) * 0.35 * Math.exp(-t / tau);
    lp += 0.35 * (noise - lp); // passe-bas : une chambre « mate »
    data[i] += lp;
  }
  const fade = Math.round(0.02 * IR_RATE);
  for (let i = 0; i < fade; i++) data[len - 1 - i] *= i / fade;

  const bytes = len * 4;
  const buf = Buffer.alloc(44 + bytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20); // IEEE float
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(IR_RATE, 24);
  buf.writeUInt32LE(IR_RATE * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < len; i++) buf.writeFloatLE(data[i], 44 + i * 4);
  return buf;
}

export function mixArgs(
  video: string,
  voice: string,
  impulse: string,
  output: string,
  start: number,
  voiceSec: number,
  videoSec: number,
  hasAudio: boolean
): string[] {
  const delayMs = Math.round(start * 1000);
  const end = start + voiceSec + PPV_ROOM.rt60;
  const tail = Math.round(IR_RATE * (PPV_ROOM.rt60 + 0.15));
  // Voix : égalisée « à distance », niveau abaissé, puis direct + pièce.
  // (amix divise chaque entrée par 2 sur le ffmpeg embarqué, de 2018, qui n'a
  // pas l'option normalize : « volume=2 » rétablit les niveaux.)
  const voiceChain =
    `[1:a]aresample=${IR_RATE},highpass=f=${PPV_ROOM.highpass},lowpass=f=${PPV_ROOM.lowpass},` +
    `loudnorm=I=${PPV_ROOM.loudness}:TP=-3:LRA=11,aresample=${IR_RATE},apad=pad_len=${tail},asplit=2[dry][toir];` +
    `[toir][2:a]afir[wetraw];` +
    `[dry]volume=${PPV_ROOM.dry}[d];[wetraw]volume=${PPV_ROOM.wet}[w];` +
    `[d][w]amix=inputs=2:duration=longest,volume=2,adelay=${delayMs}|${delayMs},apad[vo]`;
  const graph = hasAudio
    ? `[0:a]aresample=${IR_RATE},volume='if(between(t,${start.toFixed(3)},${end.toFixed(3)}),0.6,1)':eval=frame[bg];` +
      `${voiceChain};[bg][vo]amix=inputs=2:duration=first,volume=2,alimiter=limit=0.95[a]`
    : `${voiceChain};[vo]alimiter=limit=0.95[a]`;
  return [
    "-y",
    "-hide_banner",
    "-i", video,
    "-i", voice,
    "-i", impulse,
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

/** Pose la voix dans la vidéo (image intacte, son remixé « dans la pièce »). */
export async function mixVoiceIntoVideo(
  video: Buffer,
  voice: Buffer,
  place: Placement
): Promise<{ video: Buffer; duration: number; width?: number; height?: number }> {
  const dir = await mkdtemp(join(tmpdir(), "ppv-"));
  const vIn = join(dir, "in.mp4");
  const aIn = join(dir, "voice.audio");
  const ir = join(dir, "room.wav");
  const out = join(dir, "out.mp4");
  try {
    await Promise.all([
      writeFile(vIn, video),
      writeFile(aIn, voice),
      writeFile(ir, roomImpulseWav()),
    ]);
    const bin = await ffmpegBinary();
    const [pv, pa] = await Promise.all([
      run(bin, ["-hide_banner", "-i", vIn]),
      run(bin, ["-hide_banner", "-i", aIn]),
    ]);
    const videoSec = parseInputDuration(pv.stderr);
    const voiceSec = parseInputDuration(pa.stderr);
    if (!videoSec || !voiceSec) throw new Error("durée illisible (vidéo ou voix)");
    const hasAudio = /Stream #0:\d+.*Audio:/.test(pv.stderr);
    // La réverbération prolonge la voix : on la compte pour ne pas déborder
    const start = voiceStart(videoSec, voiceSec + PPV_ROOM.rt60 * 0.5, place);
    const { code, stderr } = await run(
      bin,
      mixArgs(vIn, aIn, ir, out, start, voiceSec, videoSec, hasAudio)
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
