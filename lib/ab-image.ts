// Image PNG du test A/B/C (même contenu que la carte de l'interface), envoyée
// chaque jour en privé à Teva par le bot « French Influence Voice » (BOT_TOKEN).
// Rendu sans navigateur : satori (arbre → SVG) puis resvg (SVG → PNG), police Inter dans assets/fonts.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { ADMIN_ID, VIEWER_IDS } from "./config.js";
import type { AbGroup, AbStats } from "./ab.js";

type El = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, ...children: unknown[]): El => ({
  type,
  props: { style: { display: "flex", ...style }, children: children.length === 1 ? children[0] : children },
});

const C = { ink: "#1b1b1a", mute: "#6d6d68", line: "#e3e3de", soft: "#f4f4f1", ok: "#1f8a54", voice: "#3b82f6", none: "#9ca3af", selfie: "#db2777" };
const GROUPS: [AbGroup, string, string][] = [["voice", "Vocal seul", C.voice], ["none", "Rien", C.none], ["selfie", "Selfie seul", C.selfie]];
const pc = (x: number | null | undefined) => (x == null ? "–" : `${Math.round(x * 100)} %`);
const usd = (x: number | null | undefined) => (x == null ? "–" : `${x.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`);

function tile(big: string, small: string, color = C.ink): El {
  return h("div", { flexDirection: "column", flex: 1, background: C.soft, borderRadius: 14, padding: "16px 18px" },
    h("div", { fontSize: 34, fontWeight: 700, color }, big),
    h("div", { fontSize: 17, color: C.mute }, small));
}

function row(label: string, cells: string[], bold = true): El {
  return h("div", { borderBottom: `1px solid ${C.line}`, padding: "10px 4px", alignItems: "center" },
    h("div", { flex: 2.2, fontSize: 18, color: C.mute }, label),
    ...cells.map((c) => h("div", { flex: 1, justifyContent: "flex-end", fontSize: 19, fontWeight: bold ? 700 : 400 }, c)));
}

/** Courbe du reply rate par jour d'abonnement (SVG en data URI) */
function chartSvg(ab: AbStats, w: number, hgt: number): string {
  const days = Object.keys(ab.daily).sort();
  const padL = 50, padR = 20, padT = 16, padB = 34;
  const X = (i: number) => padL + (days.length < 2 ? 0 : (i * (w - padL - padR)) / (days.length - 1));
  const Y = (r: number) => padT + (1 - Math.min(0.6, r) / 0.6) * (hgt - padT - padB);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}">`;
  for (const g of [0, 0.12, 0.24, 0.36, 0.48, 0.6]) {
    svg += `<line x1="${padL}" x2="${w - padR}" y1="${Y(g)}" y2="${Y(g)}" stroke="${C.line}"/>`;
  }
  const series: [string, string, number, (d: string) => number | null][] = [
    ...GROUPS.map(([k, , col]) => [col, k, 3, (d: string) => { const v = ab.daily[d]?.[k]; return v && v.n ? v.r / v.n : null; }] as [string, string, number, (d: string) => number | null]),
    [C.ink, "avg", 5, (d: string) => { const v = Object.values(ab.daily[d] ?? {}); const n = v.reduce((a, x) => a + x.n, 0); return n ? v.reduce((a, x) => a + x.r, 0) / n : null; }],
  ];
  for (const [col, , width, val] of series) {
    const pts = days.map((d, i) => [X(i), val(d)] as const).filter(([, v]) => v != null) as [number, number][];
    if (pts.length > 1) svg += `<polyline fill="none" stroke="${col}" stroke-width="${width}" points="${pts.map(([x, v]) => `${x},${Y(v)}`).join(" ")}"/>`;
    for (const [x, v] of pts) svg += `<circle cx="${x}" cy="${Y(v)}" r="${width + 1}" fill="${col}"/>`;
  }
  return "data:image/svg+xml;base64," + Buffer.from(svg + "</svg>").toString("base64");
}

function legend(lab: string, col: string, bold = false): El {
  return h("div", { alignItems: "center", gap: 6, color: col, fontWeight: bold ? 700 : 400 },
    h("div", { width: 12, height: 12, borderRadius: 6, background: col }), lab);
}

/** Graphique + étiquettes des axes (texte rendu par satori, positions identiques au SVG) */
function chartBlock(ab: AbStats, w: number, hgt: number): El {
  const days = Object.keys(ab.daily).sort();
  const padL = 50, padR = 20, padT = 16, padB = 34;
  const X = (i: number) => padL + (days.length < 2 ? 0 : (i * (w - padL - padR)) / (days.length - 1));
  const Y = (r: number) => padT + (1 - r / 0.6) * (hgt - padT - padB);
  const label = (txt: string, left: number, top: number, width: number, align: string): El =>
    h("div", { position: "absolute", left, top, width, justifyContent: align, fontSize: 14, color: C.mute }, txt);
  return h("div", { position: "relative", width: w, height: hgt, marginTop: 8 },
    { type: "img", props: { src: chartSvg(ab, w, hgt), width: w, height: hgt, style: { position: "absolute", left: 0, top: 0 } } },
    ...[0, 0.12, 0.24, 0.36, 0.48, 0.6].map((g) => label(`${Math.round(g * 100)} %`, 0, Y(g) - 9, padL - 8, "flex-end")),
    ...days.map((d, i) => label(`${d.slice(8, 10)}/${d.slice(5, 7)}`, X(i) - 30, hgt - 24, 60, "center")));
}

export async function abImage(ab: AbStats, now = Date.now()): Promise<Buffer> {
  const W = 1200;
  const g = (k: AbGroup) => ab[k];
  const cells = (f: (s: AbStats["voice"]) => string) => GROUPS.map(([k]) => f(g(k)));
  const days = Object.keys(ab.daily).sort().reverse();
  const date = new Date(now).toLocaleDateString("fr-FR", { timeZone: "Pacific/Tahiti" });
  const verdict = ab.significant
    ? "✅ Écart significatif."
    : `Pas encore d'écart fiable : il faut encore ~${ab.needPerGroup} fans par groupe.`;

  const tree = h("div", { flexDirection: "column", width: W, background: "#fff", padding: 32, fontFamily: "Inter", color: C.ink },
    h("div", { justifyContent: "space-between", alignItems: "baseline" },
      h("div", { fontSize: 30, fontWeight: 700 }, "Test A/B/C — message de bienvenue (Sienna)"),
      h("div", { fontSize: 18, color: C.mute }, date)),
    h("div", { fontSize: 17, color: C.mute, marginTop: 4 }, "Fans répartis au hasard : vocal seul, rien, selfie seul. On compte qui écrit dans les 72 h."),
    h("div", { gap: 12, marginTop: 18 },
      tile(pc(ab.voice.rate), "répondent AVEC vocal", C.ok),
      tile(pc(ab.none.rate), "répondent SANS rien"),
      tile(pc(ab.selfie.rate), "répondent avec SELFIE", C.ok),
      tile(ab.diffPts == null ? "–" : `${ab.diffPts >= 0 ? "+" : ""}${Math.round(ab.diffPts)} pts`, "écart vocal − rien", C.ok),
      tile(pc(ab.confidence), "confiance que l'écart est réel")),
    h("div", { marginTop: 18, borderBottom: `1px solid ${C.line}`, padding: "8px 4px" },
      h("div", { flex: 2.2 }, ""),
      ...GROUPS.map(([, lab, col]) => h("div", { flex: 1, justifyContent: "flex-end", fontSize: 18, fontWeight: 700, color: col }, lab))),
    row("Fans terminés (72 h passées)", cells((s) => String(s.done))),
    row("Ont répondu", cells((s) => `${s.replied} (${pc(s.rate)})`)),
    row("… en moins d'1 h", cells((s) => String(s.within1h)), false),
    row("Délai médian avant réponse", cells((s) => (s.medianMin == null ? "–" : `${Math.round(s.medianMin)} min`)), false),
    row("Encore dans les 72 h (déjà répondu)", cells((s) => `${s.pending} (${s.pendingReplied})`), false),
    row("CA dans les 72 h", cells((s) => `${usd(s.revenue)} · ${s.buyers} ach.`)),
    row("CA moyen par fan", cells((s) => usd(s.revPerFan))),
    row("Reply rate provisoire", cells((s) => pc(s.soFar))),
    h("div", { fontSize: 22, fontWeight: 700, marginTop: 24 }, "Reply rate par jour d'abonnement"),
    h("img", { marginTop: 8 }, null),
    h("div", { gap: 18, fontSize: 16, color: C.mute, marginTop: 4 },
      legend("Moyenne", C.ink, true),
      ...GROUPS.map(([, lab, col]) => legend(lab, col))),
    ...days.slice(0, 7).map((d) => {
      const v = ab.daily[d];
      const n = Object.values(v).reduce((a, x) => a + x.n, 0);
      const r = Object.values(v).reduce((a, x) => a + x.r, 0);
      return row(`${d.slice(8, 10)}/${d.slice(5, 7)}${d === days[0] ? " (en cours)" : ""} · moyenne ${n ? pc(r / n) : "–"} (${n})`,
        GROUPS.map(([k]) => (v[k]?.n ? `${pc(v[k].r / v[k].n)} (${v[k].n})` : "–")), false);
    }),
    h("div", { fontSize: 16, color: C.mute, marginTop: 14 }, `${verdict} ${ab.excluded} fan(s) hors test.${ab.since ? ` Depuis le ${new Date(ab.since).toLocaleDateString("fr-FR")}.` : ""}`));

  // Le graphique : l'img placée dans l'arbre (index fixe : après le titre de section)
  const kids = tree.props.children as El[];
  const imgIdx = kids.findIndex((k) => k.type === "img");
  kids[imgIdx] = chartBlock(ab, W - 64, 300);

  const height = 1000 + Math.min(7, days.length) * 48;
  const font = (w: number) => readFile(join(process.cwd(), "assets", "fonts", `inter-latin-${w}-normal.woff`));
  const [regular, bold] = await Promise.all([font(400), font(700)]);
  const svg = await satori(tree as never, {
    width: W + 64,
    height,
    fonts: [
      { name: "Inter", data: regular, weight: 400, style: "normal" },
      { name: "Inter", data: bold, weight: 700, style: "normal" },
    ],
  });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: W + 64 } }).render().asPng());
}

/** Envoie la photo en privé à Teva (et aux lecteurs) via le bot vocal (BOT_TOKEN) */
export async function sendAbImageToAdmin(png: Buffer, caption: string): Promise<void> {
  await sendAbImageTo(ADMIN_ID, png, caption);
  // Un lecteur qui n'a jamais ouvert le bot fait échouer l'envoi : sans effet sur Teva.
  for (const id of VIEWER_IDS) await sendAbImageTo(id, png, caption).catch(() => {});
}

async function sendAbImageTo(chatId: number, png: Buffer, caption: string): Promise<void> {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN manquant");
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("caption", caption);
  form.set("document", new Blob([new Uint8Array(png)], { type: "image/png" }), "test-ab.png");
  const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Telegram ${r.status} : ${(await r.text()).slice(0, 200)}`);
}
