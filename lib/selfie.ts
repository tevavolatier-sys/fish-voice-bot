// Selfie de bienvenue : la modèle tient un papier blanc, on y écrit le prénom du fan.
//   - mode « ai »   : Gemini retouche la vraie photo (écriture au feutre, bonne perspective)
//   - mode « text » : ffmpeg pose le prénom en police manuscrite (secours automatique si l'IA
//                     échoue, ou mode choisi dans l'interface)
// La photo de base et les réglages sont dans Redis (interface /api/welcome).
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRedis } from "./redis.js";
import { ffmpegBinary, run } from "./video.js";

export interface SelfieSettings {
  enabled: boolean;
  mode: "ai" | "text";
  /** Centre du prénom sur la photo, en % de la largeur / hauteur */
  x: number;
  y: number;
  /** Inclinaison (°, + = sens horaire) et taille (% de la largeur de la photo) */
  angle: number;
  size: number;
  /** Couleur du feutre (hex sans #) */
  color: string;
  /** Consigne IA supplémentaire (facultatif) */
  prompt: string;
}

export const DEFAULT_SELFIE: SelfieSettings = {
  enabled: false,
  mode: "ai",
  x: 73,
  y: 66,
  angle: 6,
  size: 17,
  color: "14143a",
  prompt: "",
};

const CFG_KEY = "welcome:selfie:cfg";
const PHOTO_KEY = "welcome:selfie:photo";
const FONT = join(process.cwd(), "assets", "Caveat-Bold.ttf");
const IMAGE_MODEL = () => process.env.WELCOME_IMAGE_MODEL?.trim() || "gemini-2.5-flash-image";
const AI_TIMEOUT_MS = 45_000;

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as T;
}

export async function getSelfieSettings(): Promise<SelfieSettings> {
  return { ...DEFAULT_SELFIE, ...(parse<Partial<SelfieSettings>>(await getRedis().get(CFG_KEY)) ?? {}) };
}

export async function saveSelfieSettings(s: Partial<SelfieSettings>): Promise<void> {
  const cur = await getSelfieSettings();
  const num = (v: unknown, d: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(v ?? d) || 0));
  const clean: SelfieSettings = {
    enabled: Boolean(s.enabled ?? cur.enabled),
    mode: s.mode === "text" ? "text" : s.mode === "ai" ? "ai" : cur.mode,
    x: num(s.x, cur.x, 0, 100),
    y: num(s.y, cur.y, 0, 100),
    angle: num(s.angle, cur.angle, -45, 45),
    size: num(s.size, cur.size, 3, 60),
    color: /^[0-9a-f]{6}$/i.test(String(s.color ?? "")) ? String(s.color).toLowerCase() : cur.color,
    prompt: String(s.prompt ?? cur.prompt).trim().slice(0, 500),
  };
  await getRedis().set(CFG_KEY, JSON.stringify(clean));
}

export async function getSelfiePhoto(): Promise<Buffer | null> {
  const b64 = await getRedis().get<string>(PHOTO_KEY);
  return b64 ? Buffer.from(b64, "base64") : null;
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "selfie-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Photo de base : ramenée à 1280 px max et en JPEG (Redis : 1 Mo max par valeur) */
export async function saveSelfiePhoto(image: Buffer): Promise<{ bytes: number }> {
  const jpeg = await withTmp(async (dir) => {
    const inp = join(dir, "in.img");
    const out = join(dir, "out.jpg");
    await writeFile(inp, image);
    const r = await run(await ffmpegBinary(), [
      "-y", "-hide_banner", "-i", inp, "-frames:v", "1",
      "-vf", "scale='min(1280,iw)':-2", "-q:v", "4", out,
    ]);
    if (r.code !== 0) throw new Error(`Photo illisible : ${r.stderr.slice(-200)}`);
    return readFile(out);
  });
  if (jpeg.length > 900_000) throw new Error("Photo trop lourde même réduite : envoie un JPEG plus petit.");
  await getRedis().set(PHOTO_KEY, jpeg.toString("base64"));
  return { bytes: jpeg.length };
}

async function imageSize(file: string): Promise<{ w: number; h: number }> {
  const r = await run(await ffmpegBinary(), ["-hide_banner", "-i", file]);
  const m = r.stderr.match(/, (\d{2,5})x(\d{2,5})[, ]/);
  if (!m) throw new Error("dimensions de la photo illisibles");
  return { w: Number(m[1]), h: Number(m[2]) };
}

/** Prénom posé au feutre (police manuscrite), incliné comme le papier, léger flou pour se fondre */
export async function selfieByText(photo: Buffer, name: string, s: SelfieSettings): Promise<Buffer> {
  return withTmp(async (dir) => {
    const inp = join(dir, "in.jpg");
    const out = join(dir, "out.jpg");
    await writeFile(inp, photo);
    const { w, h } = await imageSize(inp);
    const fontSize = Math.round((w * s.size) / 100);
    const cw = Math.round(fontSize * Math.max(3, name.length * 0.75));
    const ch = Math.round(fontSize * 1.8);
    const ow = Math.round(cw * 1.15);
    const oh = Math.round(ch * 1.5);
    const cx = Math.round((w * s.x) / 100);
    const cy = Math.round((h * s.y) / 100);
    const text = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
    const font = FONT.replace(/\\/g, "/").replace(/:/g, "\\:");
    const graph =
      `color=c=black@0:s=${cw}x${ch}:d=1,format=rgba,` +
      `drawtext=fontfile='${font}':text='${text}':fontcolor=0x${s.color}@0.88:fontsize=${fontSize}:x=(w-tw)/2:y=(h-th)/2,` +
      `rotate=${s.angle}*PI/180:c=none:ow=${ow}:oh=${oh},boxblur=0.6:1[t];` +
      `[0:v][t]overlay=x=${cx - Math.round(ow / 2)}:y=${cy - Math.round(oh / 2)}:format=auto`;
    const r = await run(await ffmpegBinary(), [
      "-y", "-hide_banner", "-i", inp, "-filter_complex", graph, "-frames:v", "1", "-q:v", "3", out,
    ]);
    if (r.code !== 0) throw new Error(`selfie texte : ${r.stderr.slice(-300)}`);
    return readFile(out);
  });
}

/** Gemini retouche la photo : le prénom écrit au feutre sur le papier, rien d'autre ne change */
export async function selfieByAi(photo: Buffer, name: string, s: SelfieSettings): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY manquante");
  const prompt =
    `Edit this photo. On the blank white sheet of paper she is holding, write exactly the name "${name}" ` +
    `in handwritten black marker, large, centered on the visible part of the sheet, following the sheet's ` +
    `perspective and lighting, as if she wrote it herself. Keep EVERYTHING else identical: her face, body, ` +
    `hair, clothes, hands, background, framing, colors. Output the edited photo only.` +
    (s.prompt ? ` ${s.prompt}` : "");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL()}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: photo.toString("base64") } }] }],
        generationConfig: { responseModalities: ["IMAGE"], temperature: 0.4 },
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    }
  );
  if (!res.ok) throw new Error(`Gemini image ${res.status} : ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const d = (await res.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] }; finishReason?: string }[];
  };
  const part = d.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error(`Gemini image : pas d'image (${d.candidates?.[0]?.finishReason ?? "réponse vide"})`);
  const img = Buffer.from(part.inlineData.data, "base64");
  // Toujours un JPEG raisonnable pour OnlyFans
  return withTmp(async (dir) => {
    const inp = join(dir, "ai.img");
    const out = join(dir, "ai.jpg");
    await writeFile(inp, img);
    const r = await run(await ffmpegBinary(), ["-y", "-hide_banner", "-i", inp, "-frames:v", "1", "-q:v", "3", out]);
    if (r.code !== 0) throw new Error("image IA illisible");
    return readFile(out);
  });
}

/**
 * Le selfie avec le prénom, ou null si pas de photo / selfie désactivé / prénom vide.
 * `how` dit quelle méthode a servi (l'IA retombe sur le texte en cas d'échec).
 */
export async function makeSelfie(
  name: string,
  opts: { force?: boolean; mode?: "ai" | "text" } = {}
): Promise<{ jpeg: Buffer; how: "ai" | "text"; aiError?: string } | null> {
  const s = await getSelfieSettings();
  if (!name || (!s.enabled && !opts.force)) return null;
  const photo = await getSelfiePhoto();
  if (!photo) return null;
  const mode = opts.mode ?? s.mode;
  if (mode === "ai") {
    try {
      return { jpeg: await selfieByAi(photo, name, s), how: "ai" };
    } catch (err) {
      const aiError = String((err as Error)?.message ?? err).slice(0, 200);
      return { jpeg: await selfieByText(photo, name, s), how: "text", aiError };
    }
  }
  return { jpeg: await selfieByText(photo, name, s), how: "text" };
}
