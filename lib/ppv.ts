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
// Volume de la voix dans les vidéos payantes : 5 niveaux réglables depuis
// le bot (boutons sous chaque PPV). Valeur = niveau visé AVANT la pièce
// (LUFS) ; le niveau moyen mesuré dans la vidéo est environ 4 dB plus bas.
export const PPV_VOLUME_LEVELS: Record<number, { lufs: number; icon: string }> = {
  1: { lufs: -59, icon: "🔈" },
  2: { lufs: -53, icon: "🔉" },
  3: { lufs: -48, icon: "🔉" },
  4: { lufs: -43, icon: "🔊" },
  5: { lufs: -38, icon: "🔊" },
};
export const PPV_DEFAULT_VOLUME = 2;

export function ppvLufs(level?: number | null): number {
  return (PPV_VOLUME_LEVELS[level ?? PPV_DEFAULT_VOLUME] ?? PPV_VOLUME_LEVELS[PPV_DEFAULT_VOLUME]).lufs;
}

// ── Rendu « filmé par l'iPhone » ───────────────────────────────────────────
// Une voix de synthèse collée telle quelle se repère : son « studio », mono
// au centre, sans la couleur du micro. On simule une personne à ~1,5 m d'un
// iPhone dans une chambre :
//   · couleur de micro de téléphone (graves coupés, médiums présents, aigus
//     adoucis) + légère compression (le contrôle de gain automatique) ;
//   · pièce en STÉRÉO : son direct un peu décentré (les 2 micros de l'iPhone
//     ne l'entendent pas au même instant) + réflexions courtes sur les murs,
//     le sol, le plafond, différentes à gauche et à droite ;
//   · presque pas de traîne (« trop d'écho » sinon) ;
//   · le son d'origine n'est PAS baissé : une vraie pièce ne se tait pas.
// Le niveau final est mesuré APRÈS la pièce (loudnorm), donc les 5 niveaux de
// volume restent comparables quel que soit le rendu.
export const PPV_ROOM = {
  highpass: 130, // Hz : un micro de téléphone coupe les graves
  lowpass: 7500, // Hz : aigus adoucis (distance + micro)
  presenceDb: 2.5, // dB vers 2,5 kHz : médiums « téléphone »
  boomCutDb: -3, // dB vers 250 Hz : pas d'effet de proximité
  tail: 0.25, // s : traîne très courte
  tailLevel: 0.05, // niveau de la traîne
} as const;

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
 * Réponse impulsionnelle STÉRÉO d'une chambre captée par un iPhone à ~1,5 m
 * (WAV 32 bits flottants, 2 canaux). Déterministe.
 */
export function roomImpulseWav(): Buffer {
  const len = Math.round(IR_RATE * (PPV_ROOM.tail + 0.08));
  const ch = [new Float32Array(len), new Float32Array(len)];
  const at = (ms: number) => Math.min(len - 1, Math.round((ms * IR_RATE) / 1000));
  // Son direct : un peu décentré (gauche), 0,2 ms d'écart entre les micros
  ch[0][at(0)] += 1;
  ch[1][at(0.2)] += 0.85;
  // Réflexions précoces (ms, gain) : sol, murs, plafond, meubles — différentes
  // pour chaque micro (c'est ce qui « place » la voix), toutes positives : un
  // mur renvoie le son sans l'inverser, et le mélange mono (haut-parleur de
  // téléphone) ne s'annule pas
  const early: [number, number][][] = [
    [[2.9, 0.5], [6.1, 0.38], [9.8, 0.3], [13.6, 0.24], [19.2, 0.18], [26.5, 0.13], [34.1, 0.09]],
    [[3.6, 0.46], [7.4, 0.36], [11.1, 0.28], [15.2, 0.22], [21.7, 0.17], [28.9, 0.12], [37.3, 0.08]],
  ];
  early.forEach((list, c) => list.forEach(([ms, g]) => (ch[c][at(ms)] += g)));
  // Traîne très courte, décorrélée entre les 2 canaux, assombrie
  const tau = PPV_ROOM.tail / 6.91;
  const start = at(12);
  [0x51ab3, 0x9e377].forEach((seed, c) => {
    const rnd = prng(seed);
    let lp = 0;
    for (let i = start; i < len; i++) {
      const t = (i - start) / IR_RATE;
      // Bruit « éclairci » (sans graves) : sinon la traîne grave domine et
      // différente à gauche/droite, elle s'annule en partie en mono
      const x = (rnd() * 2 - 1) * PPV_ROOM.tailLevel * Math.exp(-t / tau);
      ch[c][i] += x - lp;
      lp += 0.05 * (x - lp);
    }
  });
  const fade = at(15);
  for (let i = 0; i < fade; i++) {
    ch[0][len - 1 - i] *= i / fade;
    ch[1][len - 1 - i] *= i / fade;
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

export function mixArgs(
  video: string,
  voice: string,
  impulse: string,
  output: string,
  loudness: number,
  start: number,
  voiceSec: number,
  videoSec: number,
  hasAudio: boolean
): string[] {
  void voiceSec;
  const delayMs = Math.round(start * 1000);
  const tail = Math.round(IR_RATE * (PPV_ROOM.tail + 0.1));
  // Voix → micro de téléphone → pièce stéréo → niveau final → placée à `start`
  const voiceChain =
    `[1:a]aresample=${IR_RATE},` +
    `acompressor=threshold=0.125:ratio=3:attack=10:release=150:makeup=1,` +
    `highpass=f=${PPV_ROOM.highpass},lowpass=f=${PPV_ROOM.lowpass},` +
    `equalizer=f=250:width_type=o:width=1:g=${PPV_ROOM.boomCutDb},` +
    `equalizer=f=2500:width_type=o:width=1.5:g=${PPV_ROOM.presenceDb},` +
    `apad=pad_len=${tail},pan=stereo|c0=c0|c1=c0[mono2];` +
    // gtype=-1 : la pièce est appliquée telle quelle (pas de normalisation
    // automatique, qui écrasait le son direct sous la traîne)
    `[mono2][2:a]afir=gtype=-1[room];` +
    `[room]loudnorm=I=${loudness}:TP=-3:LRA=11,aresample=${IR_RATE},` +
    `adelay=${delayMs}|${delayMs},apad[vo]`;
  // amix divise chaque entrée par 2 (ffmpeg embarqué de 2018, sans l'option
  // normalize) : « volume=2 » rétablit les niveaux.
  const graph = hasAudio
    ? `[0:a]aresample=${IR_RATE}[bg];${voiceChain};` +
      `[bg][vo]amix=inputs=2:duration=first,volume=2,alimiter=limit=0.95[a]`
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
  place: Placement,
  loudness: number = ppvLufs(PPV_DEFAULT_VOLUME)
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
    const start = voiceStart(videoSec, voiceSec + PPV_ROOM.tail * 0.5, place);
    const { code, stderr } = await run(
      bin,
      mixArgs(vIn, aIn, ir, out, loudness, start, voiceSec, videoSec, hasAudio)
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
