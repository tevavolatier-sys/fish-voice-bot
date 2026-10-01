// 🎙️ VOIX PPV : PARTIE FIXE + PRÉNOM.
//
// Chaque phrase PPV = une partie FIXE (la même prise pour tous les fans,
// générée une fois — ou un vrai enregistrement de la modèle) + le PRÉNOM du
// fan, seul élément refait à chaque fois.
// Pour que le prénom ait la bonne intonation, on fait dire la phrase COMPLÈTE
// au clone (PPV_LINES), puis on n'en garde QUE le prénom : il est séparé du
// reste par une pause (« … »), qu'on repère au silence. Repli si la pause
// n'est pas trouvée : le prénom généré seul.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegBinary, parseInputDuration, run } from "./video.js";

export type LineKey = "preview" | "paid1" | "paid2";
export const LINE_KEYS: LineKey[] = ["preview", "paid1", "paid2"];

export const LINE_LABELS: Record<LineKey, string> = {
  preview: "🎁 Preview",
  paid1: "💰 PPV 1",
  paid2: "💰 PPV 2",
};

/**
 * Partie fixe de chaque phrase, et place du prénom :
 *   before → « {prénom}… » PUIS la partie fixe
 *   after  → la partie fixe PUIS « … {prénom} »
 * `nameAlone` : repli si le prénom ne peut pas être isolé de la phrase.
 */
export const PPV_FIXED: Record<
  LineKey,
  { text: string; name: "before" | "after"; nameAlone: string }
> = {
  preview: {
    text: "[soft tone] toi et moi, ça va être fou.",
    name: "before",
    nameAlone: "[soft tone] {name}…",
  },
  paid1: {
    text: "[soft tone] Hmmm… [breath] c'est chaud, toi et moi…",
    name: "after",
    nameAlone: "[soft tone] {name}.",
  },
  paid2: {
    text: "[sighing] Hmmm… [breath] [groaning] mmmh… [panting]",
    name: "after",
    nameAlone: "[sighing] {name}…",
  },
};

// ── Fonctions pures (testées dans scripts/test-ppv.ts) ─────────────────────

export type Span = { start: number; end: number };

/** Silences repérés par ffmpeg silencedetect (« silence_start: 1.2 » …) */
export function parseSilences(stderr: string, duration: number): Span[] {
  const out: Span[] = [];
  let open: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) open = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && open !== null) {
      out.push({ start: open, end: Number(e[1]) });
      open = null;
    }
  }
  if (open !== null) out.push({ start: open, end: duration }); // silence final
  return out;
}

/** Parties parlées = tout ce qui n'est pas silence (≥ 0,12 s). */
export function voicedSpans(silences: Span[], duration: number): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    if (s.start > cursor) spans.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < duration) spans.push({ start: cursor, end: duration });
  return spans.filter((v) => v.end - v.start >= 0.12);
}

/**
 * Le prénom : 1re partie parlée (before) ou dernière (after), s'il y a bien
 * une pause qui le sépare du reste et une durée plausible pour un prénom.
 */
export function pickNameSpan(
  spans: Span[],
  position: "before" | "after",
  duration: number
): Span | null {
  if (spans.length < 2) return null; // pas de pause : impossible d'isoler
  const span = position === "before" ? spans[0] : spans[spans.length - 1];
  const len = span.end - span.start;
  if (len < 0.25 || len > 1.8) return null;
  const pad = 0.04;
  return {
    start: Math.max(0, span.start - pad),
    end: Math.min(duration, span.end + pad),
  };
}

// ── Audio ──────────────────────────────────────────────────────────────────

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ppvv-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Isole le prénom dans la phrase complète. null = pause introuvable. */
export async function extractNameAudio(
  sentence: Buffer,
  position: "before" | "after"
): Promise<Buffer | null> {
  return withTmp(async (dir) => {
    const input = join(dir, "sentence.audio");
    const output = join(dir, "name.wav");
    await writeFile(input, sentence);
    const bin = await ffmpegBinary();
    const probe = await run(bin, [
      "-hide_banner", "-i", input,
      "-af", "silencedetect=noise=-38dB:d=0.16",
      "-f", "null", "-",
    ]);
    const duration = parseInputDuration(probe.stderr);
    if (!duration) return null;
    const span = pickNameSpan(
      voicedSpans(parseSilences(probe.stderr, duration), duration),
      position,
      duration
    );
    if (!span) return null;
    const len = span.end - span.start;
    const cut = await run(bin, [
      "-y", "-hide_banner",
      "-ss", span.start.toFixed(3),
      "-t", len.toFixed(3),
      "-i", input,
      "-af", `aresample=48000,afade=t=in:d=0.015,afade=t=out:st=${Math.max(0, len - 0.03).toFixed(3)}:d=0.03`,
      "-ac", "1", "-c:a", "pcm_s16le", output,
    ]);
    if (cut.code !== 0) return null;
    return readFile(output);
  });
}

// Niveau moyen (dB) d'un fichier, d'après volumedetect
function meanVolume(stderr: string): number | null {
  const m = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? Number(m[1]) : null;
}

/**
 * Assemble partie fixe + prénom (dans l'ordre voulu), le prénom ramené au
 * niveau de la partie fixe, avec une courte pause entre les deux. WAV mono.
 */
export async function joinFixedAndName(
  fixed: Buffer,
  name: Buffer,
  position: "before" | "after"
): Promise<Buffer> {
  return withTmp(async (dir) => {
    const f = join(dir, "fixed.audio");
    const n = join(dir, "name.audio");
    const out = join(dir, "line.wav");
    await Promise.all([writeFile(f, fixed), writeFile(n, name)]);
    const bin = await ffmpegBinary();
    const [vf, vn] = await Promise.all([
      run(bin, ["-hide_banner", "-i", f, "-af", "volumedetect", "-f", "null", "-"]),
      run(bin, ["-hide_banner", "-i", n, "-af", "volumedetect", "-f", "null", "-"]),
    ]);
    const gain = Math.max(-12, Math.min(12, (meanVolume(vf.stderr) ?? 0) - (meanVolume(vn.stderr) ?? 0)));
    const gap = position === "after" ? 0.28 : 0.2;
    const first = position === "before" ? "[n]" : "[f]";
    const second = position === "before" ? "[f]" : "[n]";
    const graph =
      `[0:a]aresample=48000,pan=mono|c0=c0[f];` +
      `[1:a]aresample=48000,pan=mono|c0=c0,volume=${gain.toFixed(2)}dB[n];` +
      `anullsrc=channel_layout=mono:sample_rate=48000,atrim=duration=${gap}[g];` +
      `${first}[g]${second}concat=n=3:v=0:a=1[a]`;
    const { code, stderr } = await run(bin, [
      "-y", "-hide_banner", "-i", f, "-i", n,
      "-filter_complex", graph, "-map", "[a]", "-c:a", "pcm_s16le", out,
    ]);
    if (code !== 0) throw new Error(`assemblage voix: ${stderr.slice(-400)}`);
    return readFile(out);
  });
}
