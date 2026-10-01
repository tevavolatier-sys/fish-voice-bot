// 🎬 Vocal → vidéo fond noir (MP4 vertical 720×1280, H.264 + AAC).
//
// Sert au bouton « 🎬 Video » sous chaque vocal : le chatter garde la
// version qu'il préfère et l'obtient en vidéo — même prise, aucun crédit
// Fish Audio en plus. Utile quand un fan réclame « une vidéo avec mon nom ».
//
// ffmpeg est EMBARQUÉ via @ffmpeg-installer (binaire par plateforme, installé
// par npm : linux-x64 sur Vercel). vercel.json l'inclut dans la fonction.

import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { spawn } from "node:child_process";
import { access, chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VIDEO_WIDTH = 720;
export const VIDEO_HEIGHT = 1280;
const LEAD_IN_MS = 300; // petit silence avant la voix (plus naturel au lancement)
const TAIL_S = 0.5; // et après
const TIMEOUT_MS = 40_000;

// Sur certains hébergeurs, le bit « exécutable » du binaire se perd à
// l'empaquetage : on le recopie alors dans /tmp avec les bons droits.
let resolvedBinary: string | null = null;
export async function ffmpegBinary(): Promise<string> {
  if (resolvedBinary) return resolvedBinary;
  const original = ffmpegInstaller.path;
  try {
    await access(original, constants.X_OK);
    resolvedBinary = original;
  } catch {
    const copy = join(tmpdir(), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    await copyFile(original, copy);
    await chmod(copy, 0o755);
    resolvedBinary = copy;
  }
  return resolvedBinary;
}

export function run(bin: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-10_000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg timeout"));
    }, TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

// « Duration: 00:00:02.51 » (entrée) → secondes
export function parseInputDuration(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// Durée totale de la vidéo : 300 ms de silence, la voix, 0,5 s de fin.
export function totalDuration(voiceSeconds: number): number {
  return Math.round((voiceSeconds + LEAD_IN_MS / 1000 + TAIL_S) * 100) / 100;
}

// Arguments ffmpeg : image noire + la voix (décalée de 300 ms, complétée par
// du silence), coupées EXACTEMENT à `total` secondes. (Avec « -shortest »,
// l'encodeur vidéo débordait de 1 à 2 s de noir après la voix.)
export function ffmpegArgs(input: string, output: string, total: number): string[] {
  return [
    "-y",
    "-hide_banner",
    "-f", "lavfi",
    "-i", `color=c=black:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:r=30:d=${total}`,
    "-i", input,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-af", `aresample=48000,adelay=${LEAD_IN_MS}|${LEAD_IN_MS},apad`,
    "-t", String(total),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "stillimage",
    "-crf", "30",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "160k",
    "-ar", "48000",
    "-movflags", "+faststart",
    output,
  ];
}

/** Fabrique la vidéo fond noir à partir d'un audio (MP3, OGG/Opus…). */
export async function blackVideoFromAudio(
  audio: Buffer
): Promise<{ video: Buffer; duration: number }> {
  const dir = await mkdtemp(join(tmpdir(), "vid-"));
  const input = join(dir, "in.audio");
  const output = join(dir, "out.mp4");
  try {
    await writeFile(input, audio);
    const bin = await ffmpegBinary();
    // 1) Durée de la voix : « ffmpeg -i » seul l'affiche puis s'arrête.
    const probe = await run(bin, ["-hide_banner", "-i", input]);
    const voice = parseInputDuration(probe.stderr);
    if (voice === null || voice <= 0) {
      throw new Error(`durée audio illisible: ${probe.stderr.slice(-300)}`);
    }
    const total = totalDuration(voice);
    // 2) Encodage
    const { code, stderr } = await run(bin, ffmpegArgs(input, output, total));
    if (code !== 0) {
      throw new Error(`ffmpeg code ${code}: ${stderr.slice(-600)}`);
    }
    const video = await readFile(output);
    return { video, duration: Math.max(1, Math.round(total)) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Auto-test (diagnostic GET ?diag=video) : 1 s de bip → vidéo. Résultat mis
// en cache par instance pour qu'un appel répété ne coûte rien.
let selfTest: Promise<{ ok: boolean; ms: number; bytes: number; error?: string }> | null = null;
export function videoSelfTest() {
  selfTest ??= (async () => {
    const t0 = Date.now();
    const dir = await mkdtemp(join(tmpdir(), "vidtest-"));
    try {
      const tone = join(dir, "tone.mp3");
      const bin = await ffmpegBinary();
      const gen = await run(bin, [
        "-y", "-hide_banner", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-c:a", "libmp3lame", "-q:a", "6", tone,
      ]);
      if (gen.code !== 0) throw new Error(`tone: ${gen.stderr.slice(-300)}`);
      const { video } = await blackVideoFromAudio(await readFile(tone));
      return { ok: true, ms: Date.now() - t0, bytes: video.length };
    } catch (err) {
      return {
        ok: false,
        ms: Date.now() - t0,
        bytes: 0,
        error: err instanceof Error ? err.message.slice(0, 300) : String(err),
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return selfTest;
}
