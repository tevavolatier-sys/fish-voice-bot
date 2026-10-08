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
/** Photo d'un mot écrit par la modèle elle-même : l'IA copie SON écriture (facultatif) */
const HANDWRITING_KEY = "welcome:selfie:handwriting";
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
const AI_BUDGET_MS = 40_000;

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

export async function getHandwriting(): Promise<Buffer | null> {
  const b64 = await getRedis().get<string>(HANDWRITING_KEY);
  return b64 ? Buffer.from(b64, "base64") : null;
}
export async function hasHandwriting(): Promise<boolean> {
  return (await getRedis().exists(HANDWRITING_KEY)) === 1;
}
export async function clearHandwriting(): Promise<void> {
  await getRedis().del(HANDWRITING_KEY);
}
/** Échantillon d'écriture : ramené à 1024 px max, JPEG compressé jusqu'à tenir dans Redis */
export async function saveHandwriting(image: Buffer): Promise<{ bytes: number }> {
  const b64 = await withTmp(async (dir) => {
    const inp = join(dir, "in.img");
    await writeFile(inp, image);
    const bin = await ffmpegBinary();
    for (const q of [4, 6, 8, 11, 15]) {
      const out = join(dir, `out-${q}.jpg`);
      const r = await run(bin, ["-y", "-hide_banner", "-i", inp, "-frames:v", "1", "-vf", "scale='min(1024,iw)':-2", "-q:v", String(q), out]);
      if (r.code !== 0) throw new Error(`Échantillon illisible : ${r.stderr.slice(-200)}`);
      const b = (await readFile(out)).toString("base64");
      if (b.length <= 700_000) return b;
    }
    throw new Error("Échantillon trop lourd : envoie une photo plus simple.");
  });
  await getRedis().set(HANDWRITING_KEY, b64);
  return { bytes: Math.round((b64.length * 3) / 4) };
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
export async function zoneMask(dir: string, s: SelfieSettings, w: number, h: number, g: { W: number; H: number; ox: number; oy: number }, file = "mask.png", shrink = 1): Promise<string> {
  const out = join(dir, file);
  const zb = zoneBox(s.zone);
  // shrink < 1 : zone rétrécie vers son centre (sert à repérer l'encre qui touche le bord)
  const corner = (p: [number, number]): [number, number] => [zb.cx + (p[0] - zb.cx) * shrink, zb.cy + (p[1] - zb.cy) * shrink];
  const px = (p: [number, number]) => `${Math.round((corner(p)[0] * w) / 100) + g.ox}:${Math.round((corner(p)[1] * h) / 100) + g.oy}`;
  const [tl, tr, br, bl] = s.zone;
  const graph =
    `color=c=black:s=${g.W}x${g.H}:d=1,drawbox=x=iw*0.02:y=ih*0.02:w=iw*0.96:h=ih*0.96:color=0x00ff00:t=fill,format=yuv444p,` +
    `perspective=${px(tl)}:${px(tr)}:${px(bl)}:${px(br)}:sense=destination,format=rgba,colorkey=0x00ff00:0.3:0.1`;
  const r = await run(await ffmpegBinary(), ["-y", "-hide_banner", "-f", "lavfi", "-i", graph, "-frames:v", "1", "-c:v", "png", "-pix_fmt", "rgba", out]);
  if (r.code !== 0) throw new Error(`masque : ${r.stderr.slice(-300)}`);
  return out;
}

/**
 * Ne garde de l'image IA que L'ENCRE DU PRÉNOM dans la zone d'écriture, posée sur la vraie photo.
 * 1. encre = pixel nettement plus sombre que le même pixel de l'original (le papier rendu par
 *    l'IA, même un peu beige, est ignoré ; visage, corps, fond et papier restent ceux de l'original) ;
 * 2. nettoyage : seules les taches d'encre reliées à de l'encre au CŒUR de la zone sont gardées
 *    (l'IA ajoute parfois un trait ou un point parasite le long du bord du masque) ;
 * 3. `touch` = part (×255) de la bande de bord couverte par l'encre gardée : > 0 franc = prénom coupé.
 */
export async function compositeZone(
  dir: string, original: string, aiImage: Buffer, mask: string, w: number, h: number,
  g: { W: number; H: number; ox: number; oy: number }, s: SelfieSettings
): Promise<{ jpeg: Buffer; touch: number; dropped: number }> {
  const ai = join(dir, "ai.img");
  const out = join(dir, "final.jpg");
  const inkRaw = join(dir, "ink.raw"), zoneRaw = join(dir, "zone.raw"), innerRaw = join(dir, "inner.raw"), cleanRaw = join(dir, "clean.raw");
  await writeFile(ai, aiImage);
  const inner = await zoneMask(dir, s, w, h, g, "inner.png", 0.82);
  const crop = `crop=${w}:${h}:${g.ox}:${g.oy}`;
  const bin = await ffmpegBinary();
  const graph1 =
    `[0:v]format=gray[og];` +
    `[1:v]scale=${g.W}:${g.H}:flags=lanczos,${crop},format=gray[ag];` +
    // encre = IA plus sombre que l'original d'au moins 40 (rampe douce jusqu'à 100)
    `[ag][og]blend=all_expr='clip((B-A-40)*255/60,0,255)'[ink0];` +
    `[2:v]${crop},alphaextract,negate,split[z1][z2];` +
    `[ink0][z1]blend=all_expr='A*B/255'[ink];` +
    `[3:v]${crop},alphaextract,negate[in]`;
  const raw = ["-f", "rawvideo", "-pix_fmt", "gray"];
  const r1 = await run(bin, [
    "-y", "-hide_banner", "-i", original, "-i", ai, "-i", mask, "-i", inner, "-filter_complex", graph1,
    "-map", "[ink]", "-frames:v", "1", ...raw, inkRaw,
    "-map", "[z2]", "-frames:v", "1", ...raw, zoneRaw,
    "-map", "[in]", "-frames:v", "1", ...raw, innerRaw,
  ]);
  if (r1.code !== 0) throw new Error(`carte d'encre : ${r1.stderr.slice(-300)}`);
  const [ink, zone, inr] = await Promise.all([readFile(inkRaw), readFile(zoneRaw), readFile(innerRaw)]);
  const cleaned = cleanInk(ink, zone, inr, w, h);
  await writeFile(cleanRaw, cleaned.alpha);
  // Rendu « vrai feutre » (verdict du panel du 08/10 : l'encre IA est plate, noire pure, trop nette) :
  //   - l'encre ASSOMBRIT le papier au lieu de le recouvrir (elle suit sa lumière et son grain),
  //     noir réaliste (jamais plus noir que ce que la photo permet), légèrement bleuté ;
  //   - pression variable : des nuages de bruit basse fréquence modulent la densité le long des traits ;
  //   - bords légèrement baveux (flou léger de l'alpha) pour coller au flou de la photo.
  // Réglables sans redéploiement : WELCOME_INK (densité max, 0,80), WELCOME_INK_BLUR (0,6 px), WELCOME_INK_PRESSURE (0,45).
  await renderInk(dir, original, cleanRaw, w, h, out);
  return { jpeg: await readFile(out), touch: cleaned.touch, dropped: cleaned.dropped };
}

/**
 * Rendu « vrai feutre » : pose une carte d'encre (gris w×h, fichier raw) sur la photo.
 * L'encre assombrit la luminance du papier (elle suit sa lumière et son grain), cœur du trait
 * saturé, bords baveux, pression variable (bruit basse fréquence), plus chargée aux croisements.
 */
export async function renderInk(dir: string, original: string, alphaRaw: string, w: number, h: number, out: string): Promise<void> {
  const bin = await ffmpegBinary();
  const raw = ["-f", "rawvideo", "-pix_fmt", "gray"];
  const inkMax = Math.max(0.3, Math.min(1, Number(process.env.WELCOME_INK) || 0.72));
  const blur = Math.max(0, Math.min(3, Number(process.env.WELCOME_INK_BLUR ?? 0.6)));
  const pressure = Math.max(0, Math.min(1, Number(process.env.WELCOME_INK_PRESSURE ?? 0.45)));
  const fiber = Math.max(0, Math.min(1, Number(process.env.WELCOME_INK_FIBER ?? 0.12)));
  const k = inkMax.toFixed(3);
  const seed = () => Math.floor(Math.random() * 10_000);
  // Tout en YUV pleine échelle (yuvj444p) : l'encre ne touche que la luminance (Y), la couleur du papier reste
  const graph2 =
    // 1) pression (bruit lisse, grille 40×30) appliquée AVANT la saturation : là où la main appuie moins,
    //    le trait devient aussi plus fin, pas seulement plus clair
    `color=c=0x808080:s=40x30:d=1,format=gray,noise=alls=70:allf=u:all_seed=${seed()},scale=${w}:${h}:flags=bicubic,` +
    `lutyuv=y='clip(255-${(pressure * 255).toFixed(0)}/2+(val-128)*${pressure.toFixed(2)},${(255 - pressure * 255).toFixed(0)},255)'[m];` +
    // 2) bords fibreux : bruit fin ajouté au contour avant un léger lissage (bavure dans les fibres, pas d'aérographe)
    `color=c=0x808080:s=${w}x${h}:d=1,format=gray,noise=alls=${Math.round(fiber * 60)}:allf=u:all_seed=${seed()},gblur=sigma=0.7[f];` +
    `[1:v]format=gray[a0];[a0][f]blend=all_expr='if(gt(A,8),clip(A+(B-128)*0.6,0,255),A)'[ar];` +
    `[ar][m]blend=all_expr='A*B/255',${blur > 0 ? `gblur=sigma=${blur.toFixed(2)},` : ""}lutyuv=y='clip(val*1.45,0,255)'[a1];` +
    // 3) encre nettement plus chargée aux croisements, boucles et reprises (double couche de feutre)
    `[a1]split[a1a][a1b];[a1b]gblur=sigma=3[dense];[a1a][dense]blend=all_expr='min(255,A*(0.82+0.6*B/255))'[a2];` +
    // 4) stries d'encre : 6 % de variation fine à l'intérieur du trait
    `color=c=0x808080:s=${w}x${h}:d=1,format=gray,noise=alls=40:allf=u:all_seed=${seed()}[st];` +
    `[a2][st]blend=all_expr='clip(A*(0.94+0.12*(B-128)/255+0.06),0,255)',format=yuvj444p[a3];` +
    `[0:v]format=yuvj444p[o];` +
    `[o][a3]blend=c0_expr='A*(1-${k}*B/255)':c1_expr='A':c2_expr='A'`;
  const r2 = await run(bin, [
    "-y", "-hide_banner", "-i", original, ...raw, "-s", `${w}x${h}`, "-i", alphaRaw,
    "-filter_complex", graph2, "-frames:v", "1", "-q:v", "3", out,
  ]);
  if (r2.code !== 0) throw new Error(`composition : ${r2.stderr.slice(-300)}`);
}

/**
 * Nettoyage de la carte d'encre (gris 0-255, w×h) : garde les taches d'encre franche (> 140)
 * reliées (8 voisins) à au moins un pixel du cœur de la zone (`inner`), avec leurs bords doux
 * (dilatation de 2 px) ; efface le reste (traits parasites le long du bord).
 */
export function cleanInk(ink: Buffer, zone: Buffer, inner: Buffer, w: number, h: number): { alpha: Buffer; touch: number; dropped: number } {
  const n = w * h;
  const strong = new Uint8Array(n);
  for (let i = 0; i < n; i++) strong[i] = ink[i] > 140 ? 1 : 0;
  const keep = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  let dropped = 0;
  for (let start = 0; start < n; start++) {
    if (!strong[start] || seen[start]) continue;
    // Composante connexe
    const comp: number[] = [];
    let core = false;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      if (inner[i] > 128) core = true;
      const x = i % w, y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (strong[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
    }
    if (core) for (const i of comp) keep[i] = 1;
    else dropped += comp.length;
  }
  // Bords doux : on garde l'encre faible à 2 px d'une tache gardée
  const dil = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const x = i % w, y = (i - x) / w;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) dil[ny * w + nx] = 1;
      }
    }
  }
  const alpha = Buffer.alloc(n);
  let band = 0, bandInk = 0;
  for (let i = 0; i < n; i++) {
    alpha[i] = dil[i] ? ink[i] : 0;
    if (zone[i] > 128 && inner[i] <= 128) {
      band++;
      if (keep[i]) bandInk++;
    }
  }
  return { alpha, touch: band ? (bandInk / band) * 255 : 0, dropped };
}

/** Ce qu'OpenAI reçoit : la vignette recadrée, zone modifiable en clair, reste assombri (aperçu dans l'interface) */
export async function selfieMaskPreview(photo: Buffer, s: SelfieSettings): Promise<Buffer> {
  return withTmp(async (dir) => {
    const full = join(dir, "full.jpg");
    await writeFile(full, photo);
    const { w: fw, h: fh } = await imageSize(full);
    const c = cropGeometry(s.zone, fw, fh);
    s = { ...s, zone: c.zone };
    const inp = join(dir, "in.jpg");
    const cr = await run(await ffmpegBinary(), ["-y", "-hide_banner", "-i", full, "-vf", `crop=${c.cw}:${c.ch}:${c.x}:${c.y}`, "-frames:v", "1", "-q:v", "2", inp]);
    if (cr.code !== 0) throw new Error(`recadrage : ${cr.stderr.slice(-200)}`);
    const w = c.cw, h = c.ch;
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
/**
 * Recadrage autour de la zone d'écriture (feuille + un peu de contexte) : c'est cette vignette,
 * et non le selfie entier, qui part chez OpenAI (pas de visage ni de décolleté → la modération
 * ne bronche pas ; image plus petite → plus rapide et moins chère). Marges : 10 % à gauche/droite,
 * 25 % en haut, 50 % en bas (la feuille continue sous le prénom).
 */
export function cropGeometry(zone: [number, number][], w: number, h: number): { x: number; y: number; cw: number; ch: number; zone: [number, number][] } {
  const xs = zone.map((p) => (p[0] * w) / 100), ys = zone.map((p) => (p[1] * h) / 100);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const bw = maxX - minX, bh = maxY - minY;
  const x0 = Math.max(0, Math.round(minX - bw * 0.1)), x1 = Math.min(w, Math.round(maxX + bw * 0.1));
  const y0 = Math.max(0, Math.round(minY - bh * 0.25)), y1 = Math.min(h, Math.round(maxY + bh * 0.5));
  const cw = (x1 - x0) - ((x1 - x0) % 2), ch = (y1 - y0) - ((y1 - y0) % 2);
  // La zone exprimée en % de la vignette
  const zc = zone.map(([zx, zy]): [number, number] => [(((zx * w) / 100 - x0) / cw) * 100, (((zy * h) / 100 - y0) / ch) * 100]);
  return { x: x0, y: y0, cw, ch, zone: zc };
}

/** Réglages IA ponctuels (essais depuis l'interface) : modèle, qualité, description du style d'écriture */
export interface AiOverrides {
  model?: string;
  quality?: string;
  style?: string;
  /** Ignorer l'échantillon d'écriture (comparaison) */
  noReference?: boolean;
  /** « note » = note générée puis posée (défaut) · « edit » = retouche de la photo avec masque */
  method?: "note" | "edit";
  /** Échantillon d'écriture fourni directement (essais locaux), à la place de celui de Redis */
  reference?: Buffer;
}
export const aiMethod = (ai: AiOverrides): "note" | "edit" =>
  ai.method === "edit" || ai.method === "note" ? ai.method : process.env.WELCOME_AI_METHOD?.trim() === "edit" ? "edit" : "note";

/** Description par défaut de l'écriture (ce qui rend « fait à la main ») */
export const DEFAULT_STYLE =
  "in flowing cursive handwriting (joined letters) with a thick black felt-tip marker (wide strokes), the quick " +
  "everyday handwriting of a 22-year-old woman: natural rightward slant, letters of uneven size, wobbly baseline, " +
  "pressure that varies along each stroke (darker where she pressed, lighter and slightly dry where the pen moved " +
  "fast), ink bleeding a little into the paper fibers, one or two tiny imperfections; it must look like a real " +
  "person wrote it in two seconds, never like a font";

export async function selfieByOpenAi(photo: Buffer, name: string, s: SelfieSettings, budgetMs: number, ai: AiOverrides = {}): Promise<{ jpeg: Buffer; note?: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY manquante");
  const deadline = Date.now() + budgetMs;
  return withTmp(async (dir) => {
    const full = join(dir, "full.jpg");
    await writeFile(full, photo);
    const { w: fw, h: fh } = await imageSize(full);
    const c = cropGeometry(s.zone, fw, fh);
    const sc: SelfieSettings = { ...s, zone: c.zone };
    const inp = join(dir, "in.jpg"); // la vignette = « photo » de travail
    const cr = await run(await ffmpegBinary(), ["-y", "-hide_banner", "-i", full, "-vf", `crop=${c.cw}:${c.ch}:${c.x}:${c.y}`, "-frames:v", "1", "-q:v", "2", inp]);
    if (cr.code !== 0) throw new Error(`recadrage : ${cr.stderr.slice(-200)}`);
    const w = c.cw, h = c.ch;
    const g = padGeometry(w, h);
    const padded = join(dir, "padded.png");
    const pr = await run(await ffmpegBinary(), ["-y", "-hide_banner", "-i", inp, "-vf", `pad=${g.W}:${g.H}:${g.ox}:${g.oy}:black`, "-frames:v", "1", padded]);
    if (pr.code !== 0) throw new Error(`cadrage : ${pr.stderr.slice(-200)}`);
    const mask = await zoneMask(dir, sc, w, h, g);
    const paddedBuf = await readFile(padded);
    const maskBuf = await readFile(mask);
    // Vraie écriture de la modèle (si installée) : passée en 2e image, l'IA l'imite
    const handwriting = ai.noReference ? null : ai.reference ?? (await getHandwriting());
    const basePrompt =
      `In the editable area (the blank white sheet of paper she is holding), write the name "${name}" ` +
      `${(ai.style?.trim() || process.env.WELCOME_STYLE?.trim() || DEFAULT_STYLE)}. ` +
      (handwriting
        ? `The second image shows HER real handwriting: reproduce that exact handwriting style (letter shapes, slant, ` +
          `stroke thickness, spacing, the way the marker bleeds), as if the same hand wrote the name. `
        : "") +
      `SMALL handwriting: the name spans about half of the editable area's width and its letters are at most ` +
      `one third of the area's height, centered, with large empty margins all around; it must never touch the ` +
      `edges of the area. Keep the paper white and untouched around the name. ` +
      `Spell it exactly: "${name}". Draw only the ink of the name: no fingers, no shadows, no objects, ` +
      `no smudges. Nothing else changes.` +
      (s.prompt ? ` ${s.prompt}` : "");
    let note: string | undefined;
    let best: { jpeg: Buffer; touch: number } | null = null;
    let lastRefusal = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const timeout = Math.min(AI_TIMEOUT_MS, deadline - Date.now());
      if (timeout < 12_000) break; // plus le temps d'un nouvel essai
      const prompt = attempt === 1 ? basePrompt : `${basePrompt} IMPORTANT: the previous attempt was too large and got cut off. Write it clearly SMALLER, about one third of the area's width, well inside the area.`;
      const form = new FormData();
      form.set("model", ai.model?.trim() || OPENAI_MODEL());
      form.set("prompt", prompt);
      if (handwriting) {
        form.append("image[]", new Blob([new Uint8Array(paddedBuf)], { type: "image/png" }), "photo.png");
        form.append("image[]", new Blob([new Uint8Array(handwriting)], { type: "image/jpeg" }), "handwriting.jpg");
      } else {
        form.set("image", new Blob([new Uint8Array(paddedBuf)], { type: "image/png" }), "photo.png");
      }
      form.set("mask", new Blob([new Uint8Array(maskBuf)], { type: "image/png" }), "mask.png");
      form.set("size", g.W === g.H ? "1024x1024" : g.W < g.H ? "1024x1536" : "1536x1024");
      form.set("quality", ai.quality?.trim() || OPENAI_QUALITY());
      form.set("output_format", "jpeg");
      form.set("n", "1");
      let res: Response;
      try {
        res = await fetch("https://api.openai.com/v1/images/edits", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
          body: form,
          signal: AbortSignal.timeout(timeout),
        });
      } catch (err) {
        const e = err as Error;
        throw new Error(e?.name === "TimeoutError" ? `OpenAI : pas de réponse en ${Math.round(timeout / 1000)} s` : `OpenAI : ${String(e?.message ?? err).slice(0, 120)}`);
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
        // La modération OpenAI est capricieuse (même image acceptée puis refusée) : un 2e essai passe souvent
        if (res.status === 400 && /modération/.test(msg) && attempt === 1) {
          lastRefusal = msg;
          note = "1er essai refusé par la modération, 2e essai";
          continue;
        }
        throw new Error(`OpenAI ${res.status} : ${msg}`);
      }
      const d = JSON.parse(text) as { data?: { b64_json?: string }[] };
      const b64 = d.data?.[0]?.b64_json;
      if (!b64) throw new Error("OpenAI : réponse sans image");
      const { jpeg, touch, dropped } = await compositeZone(dir, inp, Buffer.from(b64, "base64"), mask, w, h, g, sc);
      if (dropped > 0) note = `${note ? note + " · " : ""}trait parasite effacé (${dropped} px)`;
      if (!best || touch < best.touch) best = { jpeg, touch };
      if (touch < 8) break; // bon : bande vide = 0, prénom long qui frôle le bord ≈ 5, prénom coupé ≈ 15-25
      note = attempt === 1 ? `prénom coupé au bord (${touch.toFixed(1)}), 2e essai` : `encore coupé au 2e essai (${touch.toFixed(1)})`;
    }
    if (!best) throw new Error(lastRefusal ? `OpenAI 400 : ${lastRefusal}` : "OpenAI : pas le temps de générer le selfie");
    // La vignette retouchée reprend sa place dans le selfie entier (hors zone, elle est identique à l'original)
    const crop = join(dir, "crop.jpg");
    const out = join(dir, "out.jpg");
    await writeFile(crop, best.jpeg);
    const r = await run(await ffmpegBinary(), ["-y", "-hide_banner", "-i", full, "-i", crop, "-filter_complex", `[0:v][1:v]overlay=${c.x}:${c.y}:format=auto`, "-frames:v", "1", "-q:v", "3", out]);
    if (r.code !== 0) throw new Error(`remise en place : ${r.stderr.slice(-200)}`);
    return { jpeg: await readFile(out), note };
  });
}

/**
 * Mode « note » (08/10, Teva : « il faut vraiment voir que c'est écrit à la main ») :
 * l'IA ne retouche plus la photo ; elle GÉNÈRE une photo de note manuscrite au feutre sur une
 * feuille à plat (ce qu'elle imite très bien), on en découpe l'encre, puis on la pose en
 * perspective dans la zone d'écriture de la vraie photo avec le rendu « vrai feutre ».
 * Avantages : écriture vivante, taille et position exactes, jamais coupée, pas de parasites.
 */
export async function selfieByNote(photo: Buffer, name: string, s: SelfieSettings, budgetMs: number, ai: AiOverrides = {}): Promise<{ jpeg: Buffer; note?: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY manquante");
  const t0 = Date.now();
  const deadlineLeft = () => budgetMs - (Date.now() - t0);
  const timeout = Math.min(AI_TIMEOUT_MS, budgetMs);
  const wide = name.length > 7;
  const prompt =
    `Photo taken with a phone, straight-on, of a plain white sheet of paper lying flat on a table under soft indoor light. ` +
    `On the sheet, ONLY the first name "${name}" is handwritten in thick black felt-tip marker (wide, bold strokes) by a young woman, quickly and casually: ` +
    `${ai.style?.trim() || process.env.WELCOME_NOTE_STYLE?.trim() || NOTE_STYLE}. ` +
    `The word spans about ${wide ? 75 : 60}% of the width, centered. Spell it exactly: "${name}". ` +
    `Nothing else on the paper: no ruled lines, no underline, no dots, no drawings, no other text, no hands, no objects.`;
  let res: Response;
  // Un 5xx OpenAI passager (« The server had an error ») : un 2e essai passe presque toujours
  for (let attempt = 1; ; attempt++) {
  try {
    res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ai.model?.trim() || OPENAI_MODEL(),
        prompt,
        size: wide ? "1536x1024" : "1024x1024",
        quality: ai.quality?.trim() || OPENAI_QUALITY(),
        n: 1,
        output_format: "jpeg",
      }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    const e = err as Error;
    throw new Error(e?.name === "TimeoutError" ? `OpenAI : pas de réponse en ${Math.round(timeout / 1000)} s` : `OpenAI : ${String(e?.message ?? err).slice(0, 120)}`);
  }
  if (res.status >= 500 && attempt === 1 && deadlineLeft() > 15_000) continue;
  break;
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { error?: { message?: string; code?: string } };
      msg = j.error?.message ?? msg;
      if (j.error?.code === "insufficient_quota" || /quota|billing/i.test(msg)) msg = "crédit OpenAI épuisé ou carte absente (platform.openai.com → Billing)";
      else if (res.status === 401) msg = "clé OpenAI invalide (OPENAI_API_KEY sur Vercel)";
    } catch {}
    throw new Error(`OpenAI ${res.status} : ${msg}`);
  }
  const b64 = (JSON.parse(text) as { data?: { b64_json?: string }[] }).data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI : réponse sans image");
  const noteImage = Buffer.from(b64, "base64");
  // Dépannage / réglage du rendu sans regénérer : la note brute est gardée
  if (process.env.WELCOME_DEBUG_DIR) await writeFile(join(process.env.WELCOME_DEBUG_DIR, `note-${name}-${Date.now()}.jpg`), noteImage);
  return placeNote(photo, noteImage, s);
}

/** Écriture demandée pour la note : bâclée, vivante, jamais calligraphiée (Teva : « trop parfait ») */
export const NOTE_STYLE =
  "her real, sloppy, rushed everyday handwriting (NOT neat, NOT calligraphy, NOT a font): letters leaning at slightly " +
  "different angles, some letters bigger than others, the baseline drifting up and down, a few letters joined and others " +
  "not, thick uneven marker ink (heavier where she pressed and paused, thinner and a bit dry on fast strokes, a small blob " +
  "where a stroke starts), a slight tremble, written quickly while holding the paper on her knee";

/** Découpe l'encre d'une photo de note générée et la pose en perspective dans la zone d'écriture */
export async function placeNote(photo: Buffer, noteImage: Buffer, s: SelfieSettings): Promise<{ jpeg: Buffer; note?: string }> {
  return withTmp(async (dir) => {
    const full = join(dir, "full.jpg");
    const noteFile = join(dir, "note.jpg");
    await writeFile(full, photo);
    await writeFile(noteFile, noteImage);
    const bin = await ffmpegBinary();
    const raw = ["-f", "rawvideo", "-pix_fmt", "gray"];
    const { w, h } = await imageSize(full);
    const { w: nw, h: nh } = await imageSize(noteFile);
    // 1) Carte d'encre de la note : pixel nettement plus sombre que le papier autour (fond = flou large)
    const lumRaw = join(dir, "lum.raw"), bgRaw = join(dir, "bg.raw");
    const r1 = await run(bin, [
      "-y", "-hide_banner", "-i", noteFile, "-filter_complex", "[0:v]format=gray,split[l][b];[b]gblur=sigma=30[bg]",
      "-map", "[l]", "-frames:v", "1", ...raw, lumRaw, "-map", "[bg]", "-frames:v", "1", ...raw, bgRaw,
    ]);
    if (r1.code !== 0) throw new Error(`lecture de la note : ${r1.stderr.slice(-200)}`);
    const [lum, bg] = await Promise.all([readFile(lumRaw), readFile(bgRaw)]);
    const n = nw * nh;
    // Niveau du papier : le flou s'assombrit dans les zones d'encre dense (croisements) et y creusait des
    // trous blancs (panel 4) → on ne descend jamais sous le papier médian (mesuré sur toute la note)
    const sorted = Uint8Array.prototype.slice.call(lum, 0, n).sort();
    const paper = sorted[Math.floor(n * 0.6)];
    const ink = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      const base = Math.max(bg[i], paper - 12);
      ink[i] = Math.max(0, Math.min(255, Math.round(((base - lum[i] - 35) * 255) / 60)));
    }
    closeHoles(ink, nw, nh);
    const picked = pickNoteInk(ink, nw, nh);
    if (!picked) throw new Error("note générée illisible (pas d'encre nette)");
    const { alpha, x0, y0, x1, y1 } = picked;
    // 2) Vignette de l'encre avec marge (bords à 0 → rien ne déborde après déformation)
    const mx = Math.round((x1 - x0) * 0.08) + 2, my = Math.round((y1 - y0) * 0.12) + 2;
    const cx0 = Math.max(0, x0 - mx), cy0 = Math.max(0, y0 - my), cx1 = Math.min(nw, x1 + mx), cy1 = Math.min(nh, y1 + my);
    const cw = cx1 - cx0, ch = cy1 - cy0;
    const cropBuf = Buffer.alloc(cw * ch);
    for (let y = 0; y < ch; y++) alpha.copy(cropBuf, y * cw, (cy0 + y) * nw + cx0, (cy0 + y) * nw + cx1);
    // bords de la vignette forcés à 0 (la déformation étire les pixels de bord vers l'extérieur)
    for (let x = 0; x < cw; x++) { cropBuf[x] = 0; cropBuf[(ch - 1) * cw + x] = 0; }
    for (let y = 0; y < ch; y++) { cropBuf[y * cw] = 0; cropBuf[y * cw + cw - 1] = 0; }
    return placeInk(photo, cropBuf, cw, ch, s);
  });
}

/**
 * Pose une carte d'encre (vignette gris cw×ch, bords à 0) dans la zone d'écriture de la photo :
 * geste de la main, mise à l'échelle, perspective, rendu feutre. Sert à la note générée (placeNote)
 * et aux prénoms recomposés avec de vraies lettres (lib/glyphs.ts).
 */
export async function placeInk(photo: Buffer, cropBuf: Buffer, cw: number, ch: number, s: SelfieSettings): Promise<{ jpeg: Buffer; note?: string }> {
  return withTmp(async (dir) => {
    const full = join(dir, "full.jpg");
    await writeFile(full, photo);
    const bin = await ffmpegBinary();
    const raw = ["-f", "rawvideo", "-pix_fmt", "gray"];
    const { w, h } = await imageSize(full);
    const cropRaw0 = join(dir, "crop0.raw");
    await writeFile(cropRaw0, cropBuf);
    // Geste de la main : deux champs de déplacement aléatoires très lisses (8×3 points interpolés)
    // décalent l'encre en x (espacement, pente) et en y (ligne de base qui ondule, hauteurs inégales).
    // WELCOME_WOBBLE : amplitude 0..1 (0,5 ≈ ±4 % de la hauteur de la vignette), 0 = désactivé.
    const wobble = Math.max(0, Math.min(1, Number(process.env.WELCOME_WOBBLE ?? 0.6)));
    const cropRaw = join(dir, "crop.raw");
    if (wobble > 0) {
      const amp = Math.round(wobble * ch * 0.08 * 2); // force du bruit (±amp/2 px environ après lissage)
      // (cartes en gris dès la source : passer par du YUV donnait un fond à 16 au lieu de 0 → bandes grises)
      // champ lisse (ligne, tailles, pente) + champ fin de petits à-coups (une main, pas une vague)
      const field = (seed: number, grid: string, a: number) => `color=c=0x808080:s=${grid}:d=1,format=gray,noise=alls=${a}:allf=u:all_seed=${seed},scale=${cw}:${ch}:flags=bicubic`;
      const seed = () => Math.floor(Math.random() * 10_000);
      const rw = await run(bin, [
        "-y", "-hide_banner", ...raw, "-s", `${cw}x${ch}`, "-i", cropRaw0,
        "-filter_complex",
        `${field(seed(), "8x4", amp)}[xs];${field(seed(), "32x12", Math.max(2, Math.round(amp * 0.2)))}[xf];[xs][xf]blend=all_expr='clip(A+B-128,0,255)'[xm];` +
        `${field(seed(), "8x4", amp)}[ys];${field(seed(), "32x12", Math.max(2, Math.round(amp * 0.2)))}[yf];[ys][yf]blend=all_expr='clip(A+B-128,0,255)'[ym];` +
        `[0:v][xm][ym]displace=edge=smear`,
        "-frames:v", "1", ...raw, cropRaw,
      ]);
      if (rw.code !== 0) throw new Error(`geste : ${rw.stderr.slice(-200)}`);
      // Bordure remise à 0 après le geste (le déplacement peut amener de l'encre au bord ; la
      // perspective prolongerait ce bord en ligne sur la feuille). Fait en JS : drawbox passait
      // le canevas en plage limitée (fond à 16 = voile gris sur toute la photo).
      const moved = Buffer.from(await readFile(cropRaw));
      for (let b = 0; b < 4; b++) {
        for (let x = 0; x < cw; x++) { moved[b * cw + x] = 0; moved[(ch - 1 - b) * cw + x] = 0; }
        for (let y = 0; y < ch; y++) { moved[y * cw + b] = 0; moved[y * cw + cw - 1 - b] = 0; }
      }
      await writeFile(cropRaw, moved);
    } else {
      await writeFile(cropRaw, cropBuf);
    }
    // 3) Destination : boîte centrée dans la zone (62 % de sa largeur, hauteur selon le prénom, ≤ 72 % de la zone)
    const Z = s.zone.map(([zx, zy]) => [(zx * w) / 100, (zy * h) / 100] as [number, number]);
    const [tl, tr, br, bl] = Z;
    const zoneW = (dist(tl, tr) + dist(bl, br)) / 2, zoneH = (dist(tl, bl) + dist(tr, br)) / 2;
    let tw = 0.7;
    let th = (tw * zoneW * (ch / cw)) / zoneH;
    if (th > 0.75) { tw *= 0.75 / th; th = 0.75; }
    const bil = (u: number, v: number): [number, number] => [
      (1 - v) * ((1 - u) * tl[0] + u * tr[0]) + v * ((1 - u) * bl[0] + u * br[0]),
      (1 - v) * ((1 - u) * tl[1] + u * tr[1]) + v * ((1 - u) * bl[1] + u * br[1]),
    ];
    const cu = 0.5, cv = 0.48;
    const P = [bil(cu - tw / 2, cv - th / 2), bil(cu + tw / 2, cv - th / 2), bil(cu - tw / 2, cv + th / 2), bil(cu + tw / 2, cv + th / 2)];
    const px = (p: [number, number]) => `${Math.round(p[0])}:${Math.round(p[1])}`;
    // 4) Déformation : la vignette (étirée à la taille de la photo) est envoyée sur ses 4 coins de destination
    // La déformation réduit fortement la vignette étirée (≈ ×3-4) : flou préalable = anti-crénelage,
    // sinon la texture du feutre devient un pointillé sec
    const minify = w / Math.max(1, tw * zoneW);
    const aa = Math.max(0.4, 0.55 * minify).toFixed(2);
    const alphaRaw = join(dir, "alpha.raw");
    const r2 = await run(bin, [
      "-y", "-hide_banner", ...raw, "-s", `${cw}x${ch}`, "-i", cropRaw,
      "-vf", `scale=${w}:${h}:flags=bicubic,gblur=sigma=${aa},perspective=${px(P[0])}:${px(P[1])}:${px(P[2])}:${px(P[3])}:sense=destination:interpolation=cubic,format=gray`,
      "-frames:v", "1", ...raw, alphaRaw,
    ]);
    if (r2.code !== 0) throw new Error(`pose en perspective : ${r2.stderr.slice(-200)}`);
    const out = join(dir, "final.jpg");
    if (process.env.WELCOME_DEBUG_DIR) {
      // Dépannage : vignette d'encre (avant/après geste) et carte posée, en PNG
      const dd = process.env.WELCOME_DEBUG_DIR;
      await run(bin, ["-y", "-hide_banner", "-loglevel", "error", ...raw, "-s", `${cw}x${ch}`, "-i", cropRaw0, "-frames:v", "1", join(dd, "dbg-crop0.png")]);
      await run(bin, ["-y", "-hide_banner", "-loglevel", "error", ...raw, "-s", `${cw}x${ch}`, "-i", cropRaw, "-frames:v", "1", join(dd, "dbg-crop.png")]);
      await run(bin, ["-y", "-hide_banner", "-loglevel", "error", ...raw, "-s", `${w}x${h}`, "-i", alphaRaw, "-frames:v", "1", join(dd, "dbg-alpha.png")]);
    }
    await renderInk(dir, full, alphaRaw, w, h, out);
    return { jpeg: await readFile(out) };
  });
}

const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Fermeture morphologique de la carte d'encre (dilatation puis érosion, rayon 2) : bouche les
 * petits trous clairs à l'intérieur des traits (croisements, texture du feutre) sans épaissir.
 */
export function closeHoles(ink: Buffer, w: number, h: number, r = 2): void {
  const n = w * h;
  const dil = new Uint8Array(n), ero = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let dy = -r; dy <= r; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx; if (xx < 0 || xx >= w) continue;
        const v = ink[yy * w + xx]; if (v > m) m = v;
      }
    }
    dil[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 255;
    for (let dy = -r; dy <= r; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= h) { m = 0; continue; }
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx; if (xx < 0 || xx >= w) { m = 0; continue; }
        const v = dil[yy * w + xx]; if (v < m) m = v;
      }
    }
    ero[y * w + x] = m;
  }
  // on ne fait que REMPLIR : jamais moins d'encre qu'avant
  for (let i = 0; i < n; i++) if (ero[i] > ink[i]) ink[i] = ero[i];
}

/**
 * Dans la carte d'encre d'une note générée : garde les taches franches (> 140) assez grosses,
 * qui ne touchent pas le bord de l'image (ombres, bord de feuille) ; renvoie la carte nettoyée
 * (bords doux conservés) et la boîte englobante. null si rien.
 */
export function pickNoteInk(ink: Buffer, w: number, h: number): { alpha: Buffer; x0: number; y0: number; x1: number; y1: number } | null {
  const n = w * h;
  const strong = new Uint8Array(n);
  for (let i = 0; i < n; i++) strong[i] = ink[i] > 140 ? 1 : 0;
  const seen = new Uint8Array(n), keep = new Uint8Array(n);
  const minSize = Math.max(12, Math.round(n * 0.00005));
  const stack: number[] = [];
  const comps: number[][] = [];
  for (let start = 0; start < n; start++) {
    if (!strong[start] || seen[start]) continue;
    const comp: number[] = [];
    let border = false;
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % w, y = (i - x) / w;
      if (x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2) border = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (strong[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (border || comp.length < minSize) continue;
    // Trait fin et long (cadre, souligné, ligne dessinée par l'IA) : grosse boîte presque vide → écarté
    let bx0 = w, bx1 = 0, by0 = h, by1 = 0;
    for (const i of comp) { const x = i % w, y = (i - x) / w; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    const fill = comp.length / ((bx1 - bx0 + 1) * (by1 - by0 + 1));
    if (fill < 0.06 && Math.max(bx1 - bx0, by1 - by0) > 40) continue;
    // Fil pâle et fin (trait de crayon, pli, poil) : encre moyenne faible → écarté
    let sum = 0;
    for (const i of comp) sum += ink[i];
    if (sum / comp.length < 185 && fill < 0.25) continue;
    comps.push(comp);
  }
  if (!comps.length) return null;
  // Bande du prénom = étendue verticale des grosses taches (≥ 25 % de la plus grosse) ; le reste
  // (souligné, pointillés, ombres, taches isolées loin du mot) est écarté
  // (critère de HAUTEUR : un tiret de souligné peut être aussi gros qu'une lettre, mais il est plat)
  const yOf = (i: number) => (i - (i % w)) / w;
  const heights = comps.map((c) => {
    let ymin = h, ymax = 0;
    for (const i of c) { const y = yOf(i); if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
    return ymax - ymin + 1;
  });
  const tallest = Math.max(...heights);
  let bandTop = h, bandBottom = 0;
  comps.forEach((c, k) => {
    if (heights[k] < tallest * 0.35) return;
    for (const i of c) { const y = yOf(i); if (y < bandTop) bandTop = y; if (y > bandBottom) bandBottom = y; }
  });
  const margin = Math.max(4, (bandBottom - bandTop) * 0.12);
  const bandH = Math.max(1, bandBottom - bandTop);
  const xOf = (i: number) => i % w;
  // Étendue horizontale du mot = celle des grosses lettres ; une tache isolée loin du mot (petit
  // trait, point parasite à côté) est écartée même si elle est à la bonne hauteur
  let wordL = w, wordR = 0;
  comps.forEach((c, k) => {
    if (heights[k] < tallest * 0.35) return;
    for (const i of c) { const x = xOf(i); if (x < wordL) wordL = x; if (x > wordR) wordR = x; }
  });
  comps.forEach((c) => {
    let ymin = h, ymax = 0, xmin = w, xmax = 0;
    for (const i of c) { const y = yOf(i), x = xOf(i); if (y < ymin) ymin = y; if (y > ymax) ymax = y; if (x < xmin) xmin = x; if (x > xmax) xmax = x; }
    const cy = (ymin + ymax) / 2;
    const nearX = xmax >= wordL - bandH * 0.5 && xmin <= wordR + bandH * 0.5;
    // dedans si son centre est dans la bande (avec marge) et près du mot : lettres, points sur les i, accents
    if (cy >= bandTop - margin && cy <= bandBottom + margin && nearX) for (const i of c) keep[i] = 1;
  });
  let x0 = w, y0 = h, x1 = -1, y1 = -1, any = false;
  const dil = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    any = true;
    const x = i % w, y = (i - x) / w;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) dil[ny * w + nx] = 1;
    }
  }
  if (!any) return null;
  const alpha = Buffer.alloc(n);
  for (let i = 0; i < n; i++) alpha[i] = dil[i] ? ink[i] : 0;
  return { alpha, x0: Math.max(0, x0 - 2), y0: Math.max(0, y0 - 2), x1: Math.min(w, x1 + 3), y1: Math.min(h, y1 + 3) };
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
    return (await compositeZone(dir, inp, img, mask, w, h, g, s)).jpeg;
  });
}

/** Vrai inpainting : OpenAI (masque) puis Gemini, selon les clés présentes */
export async function selfieByAi(photo: Buffer, name: string, s: SelfieSettings, ai: AiOverrides = {}): Promise<{ jpeg: Buffer; provider: "openai" | "gemini"; note?: string }> {
  const providers = aiProviders();
  if (!providers.length) throw new Error("aucune clé IA image (OPENAI_API_KEY ou GEMINI_API_KEY) sur Vercel");
  const errors: string[] = [];
  const t0 = Date.now();
  for (const p of providers) {
    const left = AI_BUDGET_MS - (Date.now() - t0);
    if (left < 8_000) break;
    try {
      if (p === "openai") {
        const r = aiMethod(ai) === "note" ? await selfieByNote(photo, name, s, left, ai) : await selfieByOpenAi(photo, name, s, left, ai);
        return { jpeg: r.jpeg, provider: p, note: r.note };
      }
      return { jpeg: await selfieByGemini(photo, name, s), provider: p };
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
  opts: { force?: boolean; mode?: "ai" | "text"; ai?: AiOverrides } = {}
): Promise<{ jpeg: Buffer; how: "ai" | "text"; provider?: "openai" | "gemini"; note?: string; aiError?: string } | null> {
  const s = await getSelfieSettings();
  if (!name || (!s.enabled && !opts.force)) return null;
  const photo = await getSelfiePhoto();
  if (!photo) throw new Error("pas de photo de base installée (interface → carte Selfie)");
  const mode = opts.mode ?? s.mode;
  if (mode === "ai" && !aiProviders().length) throw new Error("aucune clé IA image (OPENAI_API_KEY ou GEMINI_API_KEY) sur Vercel");
  if (mode === "ai") {
    try {
      const r = await selfieByAi(photo, name, s, opts.ai ?? {});
      return { jpeg: r.jpeg, how: "ai", provider: r.provider, note: r.note };
    } catch (err) {
      const aiError = String((err as Error)?.message ?? err).slice(0, 200);
      if (!s.fallback && !opts.force) throw new Error(aiError); // pas de « faux » : on n'envoie pas de selfie
      return { jpeg: await selfieByText(photo, name, s), how: "text", aiError };
    }
  }
  return { jpeg: await selfieByText(photo, name, s), how: "text" };
}
