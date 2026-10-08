// Prénom recomposé à partir de VRAIES lettres : une feuille où la modèle a écrit l'alphabet au
// feutre (photo) → chaque lettre est découpée (avec son encre, ses irrégularités) → les prénoms
// sont assemblés lettre par lettre, puis posés sur la feuille du selfie par lib/selfie.ts.
// Zéro IA pour l'écriture : c'est sa main.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegBinary, run } from "./video.js";

export interface Glyph {
  /** Carte d'encre (gris 0-255), w×h */
  alpha: Buffer;
  w: number;
  h: number;
  /** Décalage du bas de la lettre sous la ligne de base de sa rangée (px, ≥ 0 : jambage) */
  below: number;
  /** Hauteur de référence de la rangée (médiane des lettres sans jambage), pour l'échelle */
  rowHeight: number;
}

export interface GlyphSheet {
  /** Lettres par caractère, plusieurs variantes possibles */
  glyphs: Record<string, Glyph[]>;
  /** Pour le diagnostic : nombre de taches par rangée */
  rows: number[];
}

/** Ordre attendu sur la feuille : majuscules puis minuscules, lues rangée par rangée */
export const SHEET_ORDER = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Carte d'encre d'une photo de feuille (pixel plus sombre que le papier autour) */
export async function inkMapOf(image: Buffer): Promise<{ ink: Buffer; w: number; h: number }> {
  const dir = await mkdtemp(join(tmpdir(), "glyph-"));
  try {
    const f = join(dir, "in.jpg");
    await writeFile(f, image);
    const bin = await ffmpegBinary();
    const probe = await run(bin, ["-hide_banner", "-i", f]);
    const m = probe.stderr.match(/, (\d{2,5})x(\d{2,5})[, ]/);
    if (!m) throw new Error("dimensions illisibles");
    const w = Number(m[1]), h = Number(m[2]);
    const raw = ["-f", "rawvideo", "-pix_fmt", "gray"];
    const lumRaw = join(dir, "lum.raw"), bgRaw = join(dir, "bg.raw");
    const r = await run(bin, [
      "-y", "-hide_banner", "-i", f, "-filter_complex", "[0:v]format=gray,split[l][b];[b]gblur=sigma=30[bg]",
      "-map", "[l]", "-frames:v", "1", ...raw, lumRaw, "-map", "[bg]", "-frames:v", "1", ...raw, bgRaw,
    ]);
    if (r.code !== 0) throw new Error(`lecture : ${r.stderr.slice(-200)}`);
    const [lum, bg] = await Promise.all([readFile(lumRaw), readFile(bgRaw)]);
    const n = w * h;
    const sorted = Uint8Array.prototype.slice.call(lum, 0, n).sort();
    const paper = sorted[Math.floor(n * 0.6)];
    const ink = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      const base = Math.max(bg[i], paper - 12);
      ink[i] = Math.max(0, Math.min(255, Math.round(((base - lum[i] - 35) * 255) / 60)));
    }
    return { ink, w, h };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

interface Comp { px: number[]; x0: number; y0: number; x1: number; y1: number }

/** Taches d'encre franche (composantes connexes, 8 voisins), hors bord et hors poussière */
function components(ink: Buffer, w: number, h: number): Comp[] {
  const n = w * h;
  const strong = new Uint8Array(n);
  for (let i = 0; i < n; i++) strong[i] = ink[i] > 140 ? 1 : 0;
  const seen = new Uint8Array(n);
  const out: Comp[] = [];
  const minSize = Math.max(10, Math.round(n * 0.00003));
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (!strong[s] || seen[s]) continue;
    const c: Comp = { px: [], x0: w, y0: h, x1: 0, y1: 0 };
    let border = false;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      c.px.push(i);
      const x = i % w, y = (i - x) / w;
      if (x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2) border = true;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (strong[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (border || c.px.length < minSize) continue;
    const fill = c.px.length / ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1));
    if (fill < 0.06 && Math.max(c.x1 - c.x0, c.y1 - c.y0) > 40) continue; // ligne, cadre
    out.push(c);
  }
  return out;
}

/** Les points des i/j et les accents sont rattachés à la lettre juste en dessous */
function mergeDots(comps: Comp[]): Comp[] {
  const big = [...comps].sort((a, b) => b.px.length - a.px.length);
  // Seuil « lettre » : 12 % de la taille médiane des 26 plus grosses taches (grain du papier, bois, poussière exclus)
  const top = big.slice(0, 26).map((c) => c.px.length).sort((a, b) => a - b);
  const letterMin = (top[Math.floor(top.length / 2)] || 0) * 0.12;
  const kept = big.filter((c) => c.px.length >= letterMin || (c.y1 - c.y0 + 1) >= 6); // les points (i, j) restent
  big.length = 0; big.push(...kept);
  const used = new Set<number>();
  const result: Comp[] = [];
  for (let k = 0; k < big.length; k++) {
    if (used.has(k)) continue;
    const c = { ...big[k], px: [...big[k].px] };
    const hc = c.y1 - c.y0 + 1;
    for (let j = 0; j < big.length; j++) {
      if (j === k || used.has(j)) continue;
      const d = big[j];
      const hd = d.y1 - d.y0 + 1;
      if (hd > hc * 0.6) continue; // pas un point
      const overlapX = Math.min(c.x1, d.x1) - Math.max(c.x0, d.x0);
      const above = d.y1 < c.y0 && c.y0 - d.y1 < hc * 0.8;
      if (overlapX > -hc * 0.15 && above) {
        c.px.push(...d.px);
        c.x0 = Math.min(c.x0, d.x0); c.x1 = Math.max(c.x1, d.x1); c.y0 = Math.min(c.y0, d.y0); c.y1 = Math.max(c.y1, d.y1);
        used.add(j);
      }
    }
    result.push(c);
  }
  return result;
}

/** Rangées (lecture) : regroupement par centre vertical, puis tri gauche → droite */
function rowsOf(comps: Comp[]): Comp[][] {
  // Les points isolés (i, j) ne définissent pas les rangées : on les rattache après
  const sizes = comps.map((c) => c.px.length).sort((a, b) => a - b);
  const medSize = sizes[Math.floor(sizes.length / 2)] || 1;
  const letters = comps.filter((c) => c.px.length >= medSize * 0.3);
  const dots = comps.filter((c) => c.px.length < medSize * 0.3);
  const sorted = [...letters].sort((a, b) => a.y0 - b.y0);
  const rows: { y0: number; y1: number; items: Comp[] }[] = [];
  for (const c of sorted) {
    const last = rows[rows.length - 1];
    if (last) {
      const overlap = Math.min(last.y1, c.y1) - Math.max(last.y0, c.y0);
      if (overlap > (c.y1 - c.y0 + 1) * 0.3) { last.items.push(c); last.y0 = Math.min(last.y0, c.y0); last.y1 = Math.max(last.y1, c.y1); continue; }
    }
    rows.push({ y0: c.y0, y1: c.y1, items: [c] });
  }
  for (const d of dots) {
    const cy = (d.y0 + d.y1) / 2;
    const r = rows.find((r) => cy >= r.y0 - (r.y1 - r.y0) * 0.3 && cy <= r.y1);
    if (r) r.items.push(d);
  }
  const out = rows.map((r) => r.items);
  for (const r of out) r.sort((a, b) => a.x0 - b.x0);
  return out;
}

/** Découpe la feuille d'alphabet en lettres, dans l'ordre SHEET_ORDER */
export async function sheetToGlyphs(sheet: Buffer, order = SHEET_ORDER): Promise<GlyphSheet> {
  const { ink, w, h } = await inkMapOf(sheet);
  let comps = mergeDots(components(ink, w, h));
  // Plus de taches que de lettres attendues : les plus petites sont du bruit (grain, poussière)
  if (comps.length > order.length) {
    const bySize = [...comps].sort((a, b) => a.px.length - b.px.length);
    const drop = new Set(bySize.slice(0, comps.length - order.length));
    comps = comps.filter((c) => !drop.has(c));
  }
  const rows = rowsOf(comps);
  const glyphs: Record<string, Glyph[]> = {};
  let k = 0;
  const counts: number[] = [];
  for (const row of rows) {
    counts.push(row.length);
    // ligne de base de la rangée = médiane des bas de lettres ; hauteur de référence = médiane des hauteurs
    const bottoms = row.map((c) => c.y1).sort((a, b) => a - b);
    const baseline = bottoms[Math.floor(bottoms.length / 2)];
    const hs = row.map((c) => c.y1 - c.y0 + 1).sort((a, b) => a - b);
    const rowHeight = hs[Math.floor(hs.length / 2)];
    for (const c of row) {
      const ch = order[k++];
      if (!ch) break;
      const gw = c.x1 - c.x0 + 1, gh = c.y1 - c.y0 + 1;
      const alpha = Buffer.alloc(gw * gh);
      // on garde aussi l'encre douce (bords) autour de la composante : copie de la boîte entière
      for (let y = 0; y < gh; y++) ink.copy(alpha, y * gw, (c.y0 + y) * w + c.x0, (c.y0 + y) * w + c.x0 + gw);
      (glyphs[ch] ??= []).push({ alpha, w: gw, h: gh, below: Math.max(0, c.y1 - baseline), rowHeight });
    }
  }
  return { glyphs, rows: counts };
}

/** Rééchantillonnage bilinéaire d'une carte gris */
function resample(src: Buffer, sw: number, sh: number, dw: number, dh: number): Buffer {
  const out = Buffer.alloc(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = ((y + 0.5) * sh) / dh - 0.5;
    const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(sh - 1, y0 + 1), ty = Math.max(0, fy - y0);
    for (let x = 0; x < dw; x++) {
      const fx = ((x + 0.5) * sw) / dw - 0.5;
      const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(sw - 1, x0 + 1), tx = Math.max(0, fx - x0);
      const a = src[y0 * sw + x0], b = src[y0 * sw + x1], c = src[y1 * sw + x0], d = src[y1 * sw + x1];
      out[y * dw + x] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
    }
  }
  return out;
}

/**
 * Assemble un prénom avec les lettres de la feuille : même échelle que sur la feuille (une lettre
 * haute reste haute), ligne de base commune, espacement et hauteur légèrement irréguliers (la main),
 * variante tirée au hasard quand une lettre existe plusieurs fois.
 * Renvoie une carte d'encre (gris) avec une marge, prête pour lib/selfie.ts placeInk().
 */
export function assembleName(sheet: GlyphSheet, name: string, opts: { height?: number; jitter?: number } = {}): { alpha: Buffer; w: number; h: number } | null {
  const H = opts.height ?? 140; // hauteur cible d'une lettre « normale » (px)
  const jitter = opts.jitter ?? 0.06;
  const rnd = (a: number) => (Math.random() * 2 - 1) * a;
  const parts: { g: Glyph; scale: number; dy: number }[] = [];
  for (const chRaw of name) {
    const ch = sheet.glyphs[chRaw] ? chRaw : sheet.glyphs[chRaw.toLowerCase()] ? chRaw.toLowerCase() : sheet.glyphs[chRaw.toUpperCase()] ? chRaw.toUpperCase() : null;
    if (!ch) {
      if (chRaw === " " || chRaw === "-") { parts.push({ g: { alpha: Buffer.alloc(1), w: 1, h: 1, below: 0, rowHeight: 1 }, scale: 0, dy: 0 }); continue; }
      return null; // lettre absente de la feuille
    }
    const variants = sheet.glyphs[ch];
    const g = variants[Math.floor(Math.random() * variants.length)];
    parts.push({ g, scale: (H / g.rowHeight) * (1 + rnd(jitter)), dy: rnd(jitter * H) });
  }
  // Boîte : largeur = somme des lettres + espaces ; hauteur = plus haute lettre + jambages + marges
  const gap = H * 0.14;
  let totalW = 0, maxAbove = 0, maxBelow = 0;
  const placed = parts.map((p) => {
    if (p.scale === 0) { totalW += H * 0.45; return null; }
    const w = Math.max(1, Math.round(p.g.w * p.scale)), h = Math.max(1, Math.round(p.g.h * p.scale));
    const below = p.g.below * p.scale;
    const above = h - below;
    maxAbove = Math.max(maxAbove, above + Math.abs(p.dy));
    maxBelow = Math.max(maxBelow, below + Math.abs(p.dy));
    const x = totalW;
    totalW += w + gap * (1 + rnd(0.5));
    return { p, w, h, below, x };
  });
  const margin = Math.round(H * 0.3);
  const W = Math.round(totalW + margin * 2), Hh = Math.round(maxAbove + maxBelow + margin * 2);
  const alpha = Buffer.alloc(W * Hh);
  const baseline = margin + maxAbove;
  for (const q of placed) {
    if (!q) continue;
    const img = resample(q.p.g.alpha, q.p.g.w, q.p.g.h, q.w, q.h);
    const x0 = Math.round(margin + q.x), y0 = Math.round(baseline + q.below - q.h + q.p.dy);
    for (let y = 0; y < q.h; y++) for (let x = 0; x < q.w; x++) {
      const X = x0 + x, Y = y0 + y;
      if (X < 0 || Y < 0 || X >= W || Y >= Hh) continue;
      const v = img[y * q.w + x];
      const i = Y * W + X;
      if (v > alpha[i]) alpha[i] = v;
    }
  }
  return { alpha, w: W, h: Hh };
}
