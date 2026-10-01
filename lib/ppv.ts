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

export function mixArgs(
  video: string,
  voice: string,
  output: string,
  start: number,
  voiceSec: number,
  videoSec: number,
  hasAudio: boolean
): string[] {
  const delayMs = Math.round(start * 1000);
  const end = start + voiceSec;
  // Voix : niveau normalisé puis remontée ; son d'origine baissé pendant qu'elle parle
  const voiceChain = `[1:a]aresample=48000,loudnorm=I=-14:TP=-1.5:LRA=11,adelay=${delayMs}|${delayMs},apad[vo]`;
  const graph = hasAudio
    ? `[0:a]aresample=48000,volume='if(between(t,${start.toFixed(3)},${end.toFixed(3)}),0.35,1)':eval=frame[bg];` +
      // amix divise chaque entrée par 2 (le ffmpeg embarqué, de 2018, n'a pas
      // l'option normalize) : « volume=2 » rétablit les niveaux.
      `${voiceChain};[bg][vo]amix=inputs=2:duration=first,volume=2,alimiter=limit=0.95[a]`
    : `${voiceChain};[vo]alimiter=limit=0.95[a]`;
  return [
    "-y",
    "-hide_banner",
    "-i", video,
    "-i", voice,
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

/** Pose la voix dans la vidéo (image intacte, son remixé). */
export async function mixVoiceIntoVideo(
  video: Buffer,
  voice: Buffer,
  place: Placement
): Promise<{ video: Buffer; duration: number; width?: number; height?: number }> {
  const dir = await mkdtemp(join(tmpdir(), "ppv-"));
  const vIn = join(dir, "in.mp4");
  const aIn = join(dir, "voice.audio");
  const out = join(dir, "out.mp4");
  try {
    await Promise.all([writeFile(vIn, video), writeFile(aIn, voice)]);
    const bin = await ffmpegBinary();
    const [pv, pa] = await Promise.all([
      run(bin, ["-hide_banner", "-i", vIn]),
      run(bin, ["-hide_banner", "-i", aIn]),
    ]);
    const videoSec = parseInputDuration(pv.stderr);
    const voiceSec = parseInputDuration(pa.stderr);
    if (!videoSec || !voiceSec) throw new Error("durée illisible (vidéo ou voix)");
    const hasAudio = /Stream #0:\d+.*Audio:/.test(pv.stderr);
    const start = voiceStart(videoSec, voiceSec, place);
    const { code, stderr } = await run(
      bin,
      mixArgs(vIn, aIn, out, start, voiceSec, videoSec, hasAudio)
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
