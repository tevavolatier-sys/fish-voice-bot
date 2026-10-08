// Aperçu local de l'interface /api/welcome, sans Vercel ni Redis (données en mémoire).
// Avec FISH_API_KEY : vraies voix Fish Audio. Sans : des bips à la place.
// Mot de passe : demo
// Lancer : npx tsx scripts/dev-welcome.ts  →  http://localhost:3005/api/welcome
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET } from "../api/welcome.js";
import { nameByRules } from "../lib/fan-name.js";
import { ffmpegBinary, run } from "../lib/video.js";
import { AB_WINDOW_MS, computeStats } from "../lib/ab.js";
import { generateVoice } from "../lib/fish.js";
import { DEFAULT_SELFIE, selfieByText, type SelfieSettings } from "../lib/selfie.js";
import { DEFAULT_SETTINGS, MONTHLY_LIMIT, STOP_AT, voiceForName, voiceId, type ChosenTake, type WelcomeSettings } from "../lib/welcome.js";

const FISH = Boolean(process.env.FISH_API_KEY);

/** Faux test A/B : 40 fans par groupe, 55 % de réponses avec vocal, 30 % sans */
function fakeAb() {
  const now = Date.now();
  const mk = (g: "voice" | "none", n: number, rate: number) =>
    Array.from({ length: n }, (_, i) => {
      const at = now - AB_WINDOW_MS - i * 3600_000 * 5;
      const replied = (i * 7919) % 100 < rate * 100;
      return { g, at, s: g === "voice" ? true : undefined, r: replied ? at + (((i * 31) % 40) + 1) * 60_000 * (i % 3 ? 1 : 30) : undefined };
    });
  return [...mk("voice", 40, 0.55), ...mk("none", 40, 0.3), { g: "voice" as const, at: now - 3600_000, s: true }, { g: "none" as const, at: now - 7200_000, r: now - 3000_000 }];
}

let settings: WelcomeSettings = { ...DEFAULT_SETTINGS };
let selfie: SelfieSettings = { ...DEFAULT_SELFIE };
let selfiePhoto: Buffer | null = null;
const takes: Record<string, ChosenTake | null> = { fixed: null, fallback: null };
const cands: Record<string, { text: string; audio: string }[]> = {};
const log = [
  { at: new Date().toISOString(), fan: "1001", display: "Alex2595839Xxx", username: "u1001", name: "Alex", ok: true },
  { at: new Date(Date.now() - 36e5).toISOString(), fan: "1002", display: "u483920", username: "", name: "", ok: false, error: "OnlyFansAPI 503 : not_sent" },
];

async function beep(freq: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "beep-"));
  const out = join(dir, "b.mp3");
  await run(await ffmpegBinary(), ["-y", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=1`, "-c:a", "libmp3lame", out]);
  const b64 = (await readFile(out)).toString("base64");
  await rm(dir, { recursive: true, force: true });
  return b64;
}

async function handle(a: Record<string, unknown>): Promise<unknown> {
  const kind = a.kind === "fallback" ? "fallback" : "fixed";
  switch (a.action) {
    case "load":
      return { ok: true, settings, takes, used: 1240, limit: MONTHLY_LIMIT, stopAt: STOP_AT, log,
        ab: computeStats(fakeAb(), Date.now()) };
    case "abReset":
      return { ok: true };
    case "selfieLoad":
      return { ok: true, settings: selfie, hasPhoto: Boolean(selfiePhoto) };
    case "selfiePhoto":
      selfiePhoto = Buffer.from(String(a.image), "base64");
      return { ok: true, bytes: selfiePhoto.length };
    case "selfieSave":
      selfie = { ...selfie, ...(a.settings as Partial<SelfieSettings>), x: Number((a.settings as SelfieSettings).x ?? selfie.x), y: Number((a.settings as SelfieSettings).y ?? selfie.y), angle: Number((a.settings as SelfieSettings).angle ?? selfie.angle), size: Number((a.settings as SelfieSettings).size ?? selfie.size), maxWidth: Number((a.settings as SelfieSettings).maxWidth ?? selfie.maxWidth) };
      return { ok: true };
    case "selfieTest": {
      const name = nameByRules(String(a.pseudo ?? ""));
      if (!name) return { ok: true, name: "", image: null };
      if (!selfiePhoto) return { ok: false, error: "Charge d'abord la photo." };
      const jpeg = await selfieByText(selfiePhoto, name, selfie);
      return { ok: true, name, how: "text", aiError: a.mode === "ai" ? "IA indisponible en local" : undefined, image: jpeg.toString("base64") };
    }
    case "save":
      settings = { ...settings, ...(a.settings as Partial<WelcomeSettings>) };
      return { ok: true };
    case "generate": {
      const text = String(a.text ?? "");
      settings = { ...settings, [kind === "fixed" ? "fixedText" : "fallbackText"]: text };
      cands[kind] = await Promise.all(
        [330, 392, 440, 494, 523].map(async (f) => ({
          text,
          audio: FISH ? (await generateVoice(text, voiceId())).toString("base64") : await beep(f),
        }))
      );
      return { ok: true, takes: cands[kind].map((c) => c.audio) };
    }
    case "choose":
      takes[kind] = { ...cands[kind][Number(a.i)], at: new Date().toISOString() };
      return { ok: true };
    case "test": {
      const name = nameByRules(String(a.pseudo ?? ""));
      const t = takes[name ? "fixed" : "fallback"];
      if (!t) return { ok: false, error: "Choisis d'abord une prise." };
      if (!FISH) return { ok: true, name, audio: t.audio };
      return { ok: true, name, audio: (await voiceForName(name, t)).toString("base64") };
    }
    case "retry":
      return { ok: true };
  }
  return { ok: false, error: "Action inconnue." };
}

createServer(async (req, res) => {
  if (req.method === "POST") {
    let raw = "";
    for await (const c of req) raw += c;
    if (req.headers["x-admin-key"] !== "demo") {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Mot de passe incorrect." }));
    }
    const out = await handle(JSON.parse(raw || "{}")).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(out));
  }
  const page = await (await GET()).text();
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
}).listen(3005, () => console.log(`Aperçu : http://localhost:3005/api/welcome (mot de passe : demo) — voix : ${FISH ? "Fish Audio" : "bips"}`));
