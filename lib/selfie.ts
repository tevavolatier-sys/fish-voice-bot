// Selfie de bienvenue : la modèle tient un papier blanc, on y écrit le prénom du fan.
//   - mode « ai »   : vrai inpainting. OpenAI GPT Image (masque exact = zone d'écriture, ≈ 0,01 $)
//                     en premier, sinon Gemini (cadre rouge en guide, ≈ 0,034 $, facturation requise).
//                     Dans les deux cas, SEULE la zone d'écriture est reprise de l'image IA : le reste
//                     (visage, corps, fond) est recopié pixel pour pixel depuis la vraie photo.
//   - mode « text » : ffmpeg pose le prénom en police manuscrite (secours si Teva l'active)
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
  zone: [[61, 50], [96, 53], [89, 65], [57, 63]],
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

/** Fournisseurs IA disponibles, dans l'ordre d'essai (WELCOME_IMAGE_PROVIDER=gemini pour forcer Gemini en premier) */
export function aiProviders(): ("openai" | "gemini")[] {
  const out: ("openai" | "gemini")[] = [];
  if (process.env.OPENAI_API_KEY) out.push("openai");
  if (process.env.GEMINI_API_KEY) out.push("gemini");
  const first = process.env.WELCOME_IMAGE_PROVIDER?.trim();
  if (first === "gemini" || first === "openai") out.sort((a, b) => (a === first ? -1 : b === first ? 1 : 0));
  return out;
}
/** Modèle et qualité OpenAI (gpt-image-1-mini : low ≈ 0,003 $, medium ≈ 0,01 $, high ≈ 0,035 $ par image) */
const OPENAI_MODEL = () => process.env.WELCOME_OPENAI_MODEL?.trim() || "gpt-image-1-mini";
const OPENAI_QUALITY = () => process.env.WELCOME_IMAGE_QUALITY?.trim() || "medium";

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

/**
 * Cadrage pour OpenAI : la photo est complétée (bandes noires) au format le plus proche
 * parmi ceux du modèle (1:1, 2:3, 3:2), pour que l'image rendue se superpose exactement.
 */
export function padGeometry(w: number, h: number): { W: number; H: number; ox: number; oy: number } {
  const ratios = [1, 2 / 3, 3 / 2];
  const r = w / h;
  const R = ratios.reduce((best, x) => (Math.abs(x - r) < Math.abs(best - r) ? x : best), ratios[0]);
  let W = w, H = h;
  if (r < R) W = Math.round(h * R);
  else H = Math.round(w / R);
  W += W % 2; H += H % 2;
  return { W, H, ox: Math.floor((W - w) / 2), oy: Math.floor((H - h) / 2) };
}

/**
 * Masque PNG (RGBA) de la taille de l'image complétée : transparent DANS la zone d'écriture
 * (c'est là que l'IA peut peindre), opaque partout ailleurs. Même astuce que le guide :
 * un rectangle vert déformé vers les 4 coins, puis rendu transparent.
 */
export async function zoneMask(dir: string, s: SelfieSettings, w: number, h: number, g: { W: number; H: number; ox: number; oy: number }): Promise<string> {
  const out = join(dir, "mask.png");
  const px = (p: [number, number]) => `${Math.round((p[0] * w) / 100) + g.ox}:${Math.round((p[1] * h) / 100) + g.oy}`;
  const [tl, tr, br, bl] = s.zone;
  const graph =
    `color=c=black:s=${g.W}x${g.H}:d=1,drawbox=x=iw*0.02:y=ih*0.02:w=iw*0.96:h=ih*0.96:color=0x00ff00:t=fill,format=yuv444p,` +
    `perspective=${px(tl)}:${px(tr)}:${px(bl)}:${px(br)}:sense=destination,format=rgba,colorkey=0x00ff00:0.3:0.1`;
  const r = await run(await ffmpegBinary(), ["-y", "-hide_banner", "-f", "lavfi", "-i", graph, "-frames:v", "1", "-c:v", "png", "-pix_fmt", "rgba", out]);
  if (r.code !== 0) throw new Error(`masque : ${r.stderr.slice(-300)}`);
  return out;
}

/**
 * Ne garde de l'image IA que L'ENCRE dans la zone d'écriture, posée sur la vraie photo :
 * un pixel est de l'encre s'il est nettement plus sombre que le même pixel de l'original
 * (le papier rendu par l'IA, même un peu beige, est ignoré ; visage, corps, fond et papier
 * restent pixel pour pixel ceux de l'original).
 */
export async function compositeZone(dir: string, original: string, aiImage: Buffer, mask: string, w: number, h: number, g: { W: number; H: number; ox: number; oy: number }): Promise<Buffer> {
  const ai = join(dir, "ai.img");
  const out = join(dir, "final.jpg");
  await writeFile(ai, aiImage);
  const graph =
    `[0:v]split[o1][o2];[o2]format=gray[og];` +
    `[1:v]scale=${g.W}:${g.H}:flags=lanczos,crop=${w}:${h}:${g.ox}:${g.oy},split[r1][r2];[r2]format=gray[ag];` +
    // encre = IA plus sombre que l'original d'au moins 40 (rampe douce jusqu'à 100)
    `[ag][og]blend=all_expr='clip((B-A-40)*255/60,0,255)'[ink];` +
    `[2:v]crop=${w}:${h}:${g.ox}:${g.oy},alphaextract,negate[z];` +
    `[ink][z]blend=all_expr='A*B/255'[a];` +
    `[r1][a]alphamerge[ra];[o1][ra]overlay=format=auto`;
  const r = await run(await ffmpegBinary(), ["-y", "-hide_banner", "-i", original, "-i", ai, "-i", mask, "-filter_complex", graph, "-frames:v", "1", "-q:v", "3", out]);
  if (r.code !== 0) throw new Error(`composition : ${r.stderr.slice(-300)}`);
  return readFile(out);
}

/** Masque et photo complétée, à usage de test (aperçu dans l'interface) */
export async function selfieMaskPreview(photo: Buffer, s: SelfieSettings): Promise<Buffer> {
  return withTmp(async (dir) => {
    const inp = join(dir, "in.jpg");
    await writeFile(inp, photo);
    const { w, h } = await imageSize(inp);
    const g = padGeometry(w, h);
    const mask = await zoneMask(dir, s, w, h, g);
    const out = join(dir, "preview.jpg");
    // La zone modifiable apparaît en clair, le reste assombri
    const graph = `[0:v]pad=${g.W}:${g.H}:${g.ox}:${g.oy}:black[p];[1:v]format=rgba,colorchannelmixer=aa=0.6[m];[p][m]overlay=format=auto`;
    const r = await run(await ffmpegBinary(), ["-y", "-hide_banner", "-i", inp, "-i", mask, "-filter_complex", graph, "-frames:v", "1", "-q:v", "4", out]);
    if (r.code !== 0) throw new Error(`aperçu masque : ${r.stderr.slice(-300)}`);
    return readFile(out);
  });
}

/**
 * OpenAI GPT Image : vrai inpainting avec masque (seule la zone d'écriture est modifiable),
 * puis composition sur la photo d'origine. Erreurs parlantes (clé, crédit, modération).
 */
export async function selfieByOpenAi(photo: Buffer, name: string, s: SelfieSettings, timeoutMs: number): Promise<Buffer> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY manquante");
  return withTmp(async (dir) => {
    const inp = join(dir, "in.jpg");
    await writeFile(inp, photo);
    const { w, h } = await imageSize(inp);
    const g = padGeometry(w, h);
    const padded = join(dir, "padded.png");
    const pr = await run(await ffmpegBinary(), ["-y", "-hide_banner", "-i", inp, "-vf", `pad=${g.W}:${g.H}:${g.ox}:${g.oy}:black`, "-frames:v", "1", padded]);
    if (pr.code !== 0) throw new Error(`cadrage : ${pr.stderr.slice(-200)}`);
    const mask = await zoneMask(dir, s, w, h, g);
    const prompt =
      `In the editable area (the blank white sheet of paper she is holding), write the name "${name}" ` +
      `as if she had written it herself with a black felt-tip marker: real handwriting, slightly irregular ` +
      `strokes, following the sheet's angle, perspective and lighting (paper grain, soft shadow). ` +
      `Centered, with generous empty margins: the name takes about two thirds of the width of the editable area ` +
      `and never touches its edges. Keep the paper white and untouched around the name. ` +
      `Spell it exactly: "${name}". Draw only the ink of the name: no fingers, no shadows, no objects, ` +
      `no smudges. Nothing else changes.` +
      (s.prompt ? ` ${s.prompt}` : "");
    const form = new FormData();
    form.set("model", OPENAI_MODEL());
    form.set("prompt", prompt);
    form.set("image", new Blob([new Uint8Array(await readFile(padded))], { type: "image/png" }), "photo.png");
    form.set("mask", new Blob([new Uint8Array(await readFile(mask))], { type: "image/png" }), "mask.png");
    form.set("size", g.W === g.H ? "1024x1024" : g.W < g.H ? "1024x1536" : "1536x1024");
    form.set("quality", OPENAI_QUALITY());
    form.set("output_format", "jpeg");
    form.set("n", "1");
    let res: Response;
    try {
      res = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      throw new Error(e?.name === "TimeoutError" ? `OpenAI : pas de réponse en ${Math.round(timeoutMs / 1000)} s` : `OpenAI : ${String(e?.message ?? err).slice(0, 120)}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 200);
      try {
        const j = JSON.parse(text) as { error?: { message?: string; code?: string; type?: string } };
        msg = j.error?.message ?? msg;
        if (j.error?.code === "insufficient_quota" || /quota|billing/i.test(msg)) msg = "crédit OpenAI épuisé ou carte absente (platform.openai.com → Billing)";
        else if (res.status === 401) msg = "clé OpenAI invalide (OPENAI_API_KEY sur Vercel)";
        else if (/safety|moderation|content policy/i.test(msg)) msg = `photo refusée par la modération OpenAI (${msg.slice(0, 100)})`;
      } catch {}
      throw new Error(`OpenAI ${res.status} : ${msg}`);
    }
    const d = JSON.parse(text) as { data?: { b64_json?: string }[] };
    const b64 = d.data?.[0]?.b64_json;
    if (!b64) throw new Error("OpenAI : réponse sans image");
    return compositeZone(dir, inp, Buffer.from(b64, "base64"), mask, w, h, g);
  });
}

/** Gemini retouche la photo (cadre rouge en guide), puis seule la zone est gardée sur l'original */
export async function selfieByGemini(photo: Buffer, name: string, s: SelfieSettings): Promise<Buffer> {
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
    return finishGemini(photo, s, Buffer.from(part.inlineData.data, "base64"));
  }
  throw new Error(`Gemini image : ${lastErr || "aucun modèle"}`);
}

/** Image Gemini (même cadrage que la photo) : seule la zone d'écriture est reportée sur l'original */
async function finishGemini(photo: Buffer, s: SelfieSettings, img: Buffer): Promise<Buffer> {
  return withTmp(async (dir) => {
    const inp = join(dir, "in.jpg");
    await writeFile(inp, photo);
    const { w, h } = await imageSize(inp);
    const g = { W: w + (w % 2), H: h + (h % 2), ox: 0, oy: 0 };
    const mask = await zoneMask(dir, s, w, h, g);
    return compositeZone(dir, inp, img, mask, w, h, g);
  });
}

/** Vrai inpainting : OpenAI (masque) puis Gemini, selon les clés présentes */
export async function selfieByAi(photo: Buffer, name: string, s: SelfieSettings): Promise<{ jpeg: Buffer; provider: "openai" | "gemini" }> {
  const providers = aiProviders();
  if (!providers.length) throw new Error("aucune clé IA image (OPENAI_API_KEY ou GEMINI_API_KEY) sur Vercel");
  const errors: string[] = [];
  const t0 = Date.now();
  for (const p of providers) {
    const left = AI_BUDGET_MS - (Date.now() - t0);
    if (left < 8_000) break;
    try {
      const jpeg = p === "openai" ? await selfieByOpenAi(photo, name, s, Math.min(AI_TIMEOUT_MS, left)) : await selfieByGemini(photo, name, s);
      return { jpeg, provider: p };
    } catch (err) {
      errors.push(String((err as Error)?.message ?? err).slice(0, 160));
    }
  }
  throw new Error(errors.join(" · ") || "IA image indisponible");
}

/**
 * Le selfie avec le prénom, ou null si pas de photo / selfie désactivé / prénom vide.
 * `how` dit quelle méthode a servi (l'IA retombe sur le texte en cas d'échec).
 */
export async function makeSelfie(
  name: string,
  opts: { force?: boolean; mode?: "ai" | "text" } = {}
): Promise<{ jpeg: Buffer; how: "ai" | "text"; provider?: "openai" | "gemini"; aiError?: string } | null> {
  const s = await getSelfieSettings();
  if (!name || (!s.enabled && !opts.force)) return null;
  const photo = await getSelfiePhoto();
  if (!photo) throw new Error("pas de photo de base installée (interface → carte Selfie)");
  const mode = opts.mode ?? s.mode;
  if (mode === "ai" && !aiProviders().length) throw new Error("aucune clé IA image (OPENAI_API_KEY ou GEMINI_API_KEY) sur Vercel");
  if (mode === "ai") {
    try {
      const r = await selfieByAi(photo, name, s);
      return { jpeg: r.jpeg, how: "ai", provider: r.provider };
    } catch (err) {
      const aiError = String((err as Error)?.message ?? err).slice(0, 200);
      if (!s.fallback && !opts.force) throw new Error(aiError); // pas de « faux » : on n'envoie pas de selfie
      return { jpeg: await selfieByText(photo, name, s), how: "text", aiError };
    }
  }
  return { jpeg: await selfieByText(photo, name, s), how: "text" };
}
