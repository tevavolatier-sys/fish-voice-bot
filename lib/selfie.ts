// Selfie de bienvenue : la modèle tient un papier blanc, on y écrit le prénom du fan.
//   - mode « ai »   : Gemini retouche la vraie photo (écriture au feutre, bonne perspective)
//   - mode « text » : ffmpeg pose le prénom en police manuscrite (secours automatique si l'IA
//                     échoue, ou mode choisi dans l'interface)
// La photo de base et les réglages sont dans Redis (interface /api/welcome).
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  /** Largeur max du prénom (% de la largeur de la photo) : les longs prénoms sont réduits */
  maxWidth: number;
  /** Couleur du feutre (hex sans #) */
  color: string;
  /** Consigne IA supplémentaire (facultatif) */
  prompt: string;
  /** Si l'IA échoue : poser le texte (true) ou ne pas envoyer de selfie (false, Teva : « je veux du vrai ») */
  fallback: boolean;
  /**
   * Zone d'écriture sur la feuille : 4 coins en % (haut-gauche, haut-droit, bas-droit, bas-gauche).
   * Montrée à l'IA en liseré rouge (image guide) pour que le prénom reste SUR la feuille, loin de la main.
   */
  zone: [number, number][];
}

export const DEFAULT_SELFIE: SelfieSettings = {
  enabled: false,
  mode: "ai",
  // Texte posé : au centre de la zone d'écriture (ci-dessous), inclinaison du papier
  x: 76,
  y: 59,
  angle: 6,
  size: 17,
  maxWidth: 32,
  color: "14143a",
  prompt: "",
  fallback: false,
  // Photo de Sienna du 07/10/2026 : partie haute de la feuille, à l'écart des doigts
  zone: [[61, 50], [96, 53], [91, 68], [57, 66]],
};

const CFG_KEY = "welcome:selfie:cfg";
const PHOTO_KEY = "welcome:selfie:photo";
const FONT = join(process.cwd(), "assets", "Caveat-Bold.ttf");
/**
 * Modèles d'image Gemini essayés dans l'ordre (IDs stables au 07/10/2026 ; les « -preview » sont
 * arrêtés, 2.5-flash-image est réservé aux anciens utilisateurs) ; WELCOME_IMAGE_MODEL passe devant.
 * ⚠️ Aucun modèle image n'existe dans l'offre gratuite : la clé Gemini doit être sur un projet
 * Google Cloud avec facturation (≈ 0,04 $ par selfie avec nano-banana-2.1).
 */
const IMAGE_MODELS = () =>
  [process.env.WELCOME_IMAGE_MODEL?.trim(), "gemini-nano-banana-2.1", "gemini-3.1-flash-image", "gemini-3.1-flash-lite-image"].filter(
    (m, i, a): m is string => Boolean(m) && a.indexOf(m) === i
  );
/** Délai max par modèle, et budget total de la cascade (la fonction Vercel de 60 s fait aussi la voix et les uploads) */
const AI_TIMEOUT_MS = 25_000;
const AI_BUDGET_MS = 35_000;

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as T;
}

export async function getSelfieSettings(): Promise<SelfieSettings> {
  return { ...DEFAULT_SELFIE, ...(parse<Partial<SelfieSettings>>(await getRedis().get(CFG_KEY)) ?? {}) };
}

export async function saveSelfieSettings(s: Partial<SelfieSettings>): Promise<void> {
  const cur = await getSelfieSettings();
  // Champ vide ou illisible → on garde la valeur actuelle (jamais 0 par accident)
  const num = (v: unknown, d: number, lo: number, hi: number) => {
    const n = Number(v);
    return v === "" || v == null || !Number.isFinite(n) ? d : Math.max(lo, Math.min(hi, n));
  };
  const clean: SelfieSettings = {
    enabled: Boolean(s.enabled ?? cur.enabled),
    mode: s.mode === "text" ? "text" : s.mode === "ai" ? "ai" : cur.mode,
    x: num(s.x, cur.x, 0, 100),
    y: num(s.y, cur.y, 0, 100),
    angle: num(s.angle, cur.angle, -45, 45),
    size: num(s.size, cur.size, 3, 60),
    maxWidth: num(s.maxWidth, cur.maxWidth, 5, 100),
    color: /^[0-9a-f]{6}$/i.test(String(s.color ?? "")) ? String(s.color).toLowerCase() : cur.color,
    prompt: String(s.prompt ?? cur.prompt).trim().slice(0, 500),
    fallback: Boolean(s.fallback ?? cur.fallback),
    zone: cleanZone(s.zone) ?? cur.zone,
  };
  await getRedis().set(CFG_KEY, JSON.stringify(clean));
}

function cleanZone(z: unknown): [number, number][] | null {
  if (!Array.isArray(z) || z.length !== 4) return null;
  const out: [number, number][] = [];
  for (const p of z) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const x = Number(p[0]), y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push([Math.max(0, Math.min(100, x)), Math.max(0, Math.min(100, y))]);
  }
  // Quadrilatère dégénéré (coins confondus, champs vidés) : refusé
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = out[i], [x2, y2] = out[(i + 1) % 4];
    area += x1 * y2 - x2 * y1;
  }
  if (Math.abs(area) / 2 < 1) return null;
  return out;
}

/** Centre et largeur (en %) de la zone d'écriture */
function zoneBox(zone: [number, number][]): { cx: number; cy: number; width: number } {
  const xs = zone.map((p) => p[0]), ys = zone.map((p) => p[1]);
  return {
    cx: xs.reduce((a, b) => a + b, 0) / 4,
    cy: ys.reduce((a, b) => a + b, 0) / 4,
    width: Math.max(...xs) - Math.min(...xs),
  };
}

/**
 * Image guide : la photo avec la zone d'écriture en liseré rouge (pour l'IA et pour l'aperçu).
 * Un cadre rouge sur fond vert est déformé (perspective) vers les 4 coins (le vert, étiré hors zone, est rendu transparent), puis posé sur la photo.
 */
export async function selfieGuide(photo: Buffer, s: SelfieSettings): Promise<Buffer> {
  return withTmp(async (dir) => {
    const inp = join(dir, "in.jpg");
    const out = join(dir, "guide.jpg");
    await writeFile(inp, photo);
    const { w, h } = await imageSize(inp);
    const px = (p: [number, number]) => `${Math.round((p[0] * w) / 100)}:${Math.round((p[1] * h) / 100)}`;
    const [tl, tr, br, bl] = s.zone;
    const t = Math.max(3, Math.round(w / 150));
    const graph =
      `color=c=0x00ff00:s=${w}x${h}:d=1,drawbox=x=iw*0.03:y=ih*0.03:w=iw*0.94:h=ih*0.94:color=red:t=${t},format=yuv444p,` +
      `perspective=${px(tl)}:${px(tr)}:${px(bl)}:${px(br)}:sense=destination,format=rgba,colorkey=0x00ff00:0.3:0.1[g];` +
      `[0:v][g]overlay=format=auto`;
    const r = await run(await ffmpegBinary(), ["-y", "-hide_banner", "-i", inp, "-filter_complex", graph, "-frames:v", "1", "-q:v", "3", out]);
    if (r.code !== 0) throw new Error(`guide : ${r.stderr.slice(-300)}`);
    return readFile(out);
  });
}

export async function getSelfiePhoto(): Promise<Buffer | null> {
  const b64 = await getRedis().get<string>(PHOTO_KEY);
  return b64 ? Buffer.from(b64, "base64") : null;
}

/** Une photo de base est-elle installée ? (sans la télécharger) */
export async function hasSelfiePhoto(): Promise<boolean> {
  return (await getRedis().exists(PHOTO_KEY)) === 1;
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "selfie-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Photo de base : ramenée à 1280 px max et en JPEG. Redis (Upstash) refuse une valeur
 * de plus de 1 Mo : on compresse de plus en plus jusqu'à tenir (base64 = ×1,33).
 */
export async function saveSelfiePhoto(image: Buffer): Promise<{ bytes: number }> {
  const b64 = await withTmp(async (dir) => {
    const inp = join(dir, "in.img");
    await writeFile(inp, image);
    const bin = await ffmpegBinary();
    for (const q of [4, 6, 8, 11, 15]) {
      const out = join(dir, `out-${q}.jpg`);
      const r = await run(bin, ["-y", "-hide_banner", "-i", inp, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", String(q), out]);
      if (r.code !== 0) throw new Error(`Photo illisible : ${r.stderr.slice(-200)}`);
      const b = (await readFile(out)).toString("base64");
      if (b.length <= 950_000) return b;
    }
    throw new Error("Photo trop lourde même compressée : envoie un JPEG plus simple.");
  });
  await getRedis().set(PHOTO_KEY, b64);
  return { bytes: Math.round((b64.length * 3) / 4) };
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
    // Caveat : un caractère ≈ 0,42 × la taille de police ; on réduit pour tenir dans la largeur max
    const maxPx = (w * s.maxWidth) / 100;
    const fontSize = Math.round(Math.min((w * s.size) / 100, maxPx / (0.42 * Math.max(1, name.length))));
    const cw = Math.round(fontSize * Math.max(3, name.length * 0.75));
    const ch = Math.round(fontSize * 1.8);
    const ow = Math.round(cw * 1.15);
    const oh = Math.round(ch * 1.5);
    const cx = Math.round((w * s.x) / 100);
    const cy = Math.round((h * s.y) / 100);
    // Le prénom passe par un fichier : une apostrophe (D'Angelo) casserait le graphe en ligne
    const txt = join(dir, "name.txt");
    await writeFile(txt, name, "utf8");
    const ff = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:");
    await access(FONT).catch(() => {
      throw new Error("police Caveat absente du déploiement (assets/Caveat-Bold.ttf, includeFiles dans vercel.json)");
    });
    const graph =
      `color=c=black@0:s=${cw}x${ch}:d=1,format=rgba,` +
      `drawtext=fontfile='${ff(FONT)}':textfile='${ff(txt)}':fontcolor=0x${s.color}@0.88:fontsize=${fontSize}:x=(w-tw)/2:y=(h-th)/2,` +
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
  const guide = await selfieGuide(photo, s);
  // Gemini n'a pas de masque : on décrit la zone en mots (« semantic masking ») ET on montre
  // le cadre rouge sur une 2e image, pour que le prénom reste sur la feuille, loin des doigts.
  const z = zoneBox(s.zone);
  const where = `${z.cy < 50 ? "upper" : "lower"} ${z.cx < 40 ? "left" : z.cx > 60 ? "right" : "middle"} part of the frame`;
  const prompt =
    `Photo editing task (inpainting). Image 1 is a real selfie of a woman holding a blank white sheet of paper. ` +
    `Image 2 is the same photo with a RED OUTLINE: that outline marks the ONLY area where writing is allowed ` +
    `(the blank part of the sheet, away from her fingers). In words, the allowed area is the ${where}, ` +
    `on the blank sheet above her fingers. Image 2 is only a guide: copy nothing from it except the position ` +
    `of the area; base the result on image 1. ` +
    `Edit image 1: write the name "${name}" on the sheet as if she had written it herself with a black felt-tip ` +
    `marker: real handwriting, slightly irregular strokes, ink slightly uneven, large, centered inside the allowed ` +
    `area with comfortable margins, never touching or crossing the outline, never over her hand or outside the sheet, ` +
    `following the sheet's angle, perspective and lighting (shadows, paper grain). ` +
    `Spell the name EXACTLY: "${name}". Change nothing else: same face, skin, hair, body, clothes, hands, ` +
    `background, framing, colors and image quality. The red outline must NOT appear in the result. ` +
    `Return only the edited photo.` +
    (s.prompt ? ` ${s.prompt}` : "");
  const img = (b: Buffer) => ({ inline_data: { mime_type: "image/jpeg", data: b.toString("base64") } });
  let lastErr = "";
  const t0 = Date.now();
  for (const model of IMAGE_MODELS()) {
    const left = AI_BUDGET_MS - (Date.now() - t0);
    if (left < 5_000) break; // plus le temps d'essayer un autre modèle dans la fonction Vercel
    const timeout = Math.min(AI_TIMEOUT_MS, left);
    let res: Response;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }, img(photo), img(guide)] }],
          // Pas de temperature : Gemini 3 recommande la valeur par défaut ; 1K par défaut (2K = double prix)
          generationConfig: { responseModalities: ["IMAGE"] },
        }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      const e = err as Error;
      lastErr = `${model} → ${e?.name === "TimeoutError" ? `pas de réponse en ${Math.round(timeout / 1000)} s` : String(e?.message ?? err).slice(0, 120)}`;
      continue;
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      lastErr = `${model} → ${res.status} ${body.slice(0, 160)}`;
      if (/location is not supported/i.test(body)) {
        throw new Error("Gemini image : région non prise en charge (Polynésie) — ça marche depuis Vercel (USA), pas en local");
      }
      if (res.status === 429 && /limit:\s*0|billing|free[_ ]tier/i.test(body)) {
        throw new Error(
          "Gemini image : les modèles image ne sont pas dans l'offre gratuite. Activer la facturation sur le projet Google Cloud de la clé (aistudio.google.com/apikey → projet → Facturation), régénérer la clé si elle date d'avant, puis réessayer."
        );
      }
      if (res.status === 429) lastErr += " (quota images/min atteint, ou clé sans facturation)";
      if ([400, 404, 429, 503].includes(res.status)) continue; // inconnu / non supporté / quota (par modèle) / saturé : suivant
      throw new Error(`Gemini image : ${lastErr}`);
    }
    const d = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };
    const part = d.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) {
      const why = d.promptFeedback?.blockReason ?? d.candidates?.[0]?.finishReason ?? "réponse vide";
      const said = d.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text?.slice(0, 80);
      lastErr = `${model} → pas d'image (${why}${said ? ` : ${said}` : ""})`;
      continue;
    }
    return finishAi(Buffer.from(part.inlineData.data, "base64"));
  }
  throw new Error(`Gemini image : ${lastErr || "aucun modèle"}`);
}

async function finishAi(img: Buffer): Promise<Buffer> {
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
  if (!photo) throw new Error("pas de photo de base installée (interface → carte Selfie)");
  const mode = opts.mode ?? s.mode;
  if (mode === "ai" && !process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY manquante sur Vercel");
  if (mode === "ai") {
    try {
      return { jpeg: await selfieByAi(photo, name, s), how: "ai" };
    } catch (err) {
      const aiError = String((err as Error)?.message ?? err).slice(0, 200);
      if (!s.fallback && !opts.force) throw new Error(aiError); // pas de « faux » : on n'envoie pas de selfie
      return { jpeg: await selfieByText(photo, name, s), how: "text", aiError };
    }
  }
  return { jpeg: await selfieByText(photo, name, s), how: "text" };
}
