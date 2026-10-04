// 📣 MASS MESSAGES PPV : textes de vente OnlyFans en français / anglais,
// SUGGESTIFS mais jamais explicites, avec {name} pour le prénom du fan.
// Réglages par opérateur (Redis), génération par Gemini, filtre de sécurité.

import { InlineKeyboard } from "grammy";

export type Lang = "fr" | "en";
export interface MassSettings {
  lang: Lang;
  theme: string; // clé de THEMES ou « custom »
  customTheme: string;
  tone: string;
  tease: number; // 1 doux → 3 très aguicheur (toujours non explicite)
  length: string;
  emojis: string;
  price: number;
  oldPrice: number;
  expiryH: number;
  bonuses: boolean;
  girl: string;
  variants: number;
  content: string; // ce que contient le PPV (décrit par le chatter)
}

export const THEMES: Record<string, string> = {
  oops: "😳 Oops",
  vip: "👑 VIP",
  flash: "⚡ Flash sale",
  night: "🌙 Late night",
  morning: "☀️ Good morning",
  holiday: "🎉 Holiday",
  birthday: "🎂 Birthday",
  custom: "✏️ Custom",
};
export const TONES: Record<string, string> = { sweet: "🥰 Sweet", playful: "😜 Playful", bold: "😈 Bold" };
export const LENGTHS: Record<string, string> = { short: "Short", medium: "Medium", long: "Long" };
export const EMOJIS: Record<string, string> = { few: "Few", normal: "Normal", lots: "Lots" };

export function defaultMass(): MassSettings {
  return {
    lang: "fr", theme: "oops", customTheme: "", tone: "playful", tease: 2, length: "medium",
    emojis: "normal", price: 24.99, oldPrice: 300, expiryH: 24, bonuses: true, girl: "Sienna",
    variants: 3, content: "",
  };
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function normalizeMass(raw: unknown): MassSettings {
  const d = defaultMass();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, map: Record<string, string>, def: T): T =>
    typeof v === "string" && v in map ? (v as T) : def;
  const num = (v: unknown, def: number) => (typeof v === "number" && Number.isFinite(v) ? v : def);
  const str = (v: unknown, def: string, max: number) => (typeof v === "string" ? v.slice(0, max) : def);
  return {
    lang: r.lang === "en" ? "en" : "fr",
    theme: pick(r.theme, THEMES, d.theme),
    customTheme: str(r.customTheme, "", 200),
    tone: pick(r.tone, TONES, d.tone),
    tease: clamp(Math.round(num(r.tease, d.tease)), 1, 3),
    length: pick(r.length, LENGTHS, d.length),
    emojis: pick(r.emojis, EMOJIS, d.emojis),
    price: clamp(Math.round(num(r.price, d.price) * 100) / 100, 3, 500),
    oldPrice: clamp(Math.round(num(r.oldPrice, d.oldPrice)), 0, 5000),
    expiryH: clamp(Math.round(num(r.expiryH, d.expiryH)), 0, 168),
    bonuses: typeof r.bonuses === "boolean" ? r.bonuses : d.bonuses,
    girl: str(r.girl, d.girl, 30).trim() || d.girl,
    variants: clamp(Math.round(num(r.variants, d.variants)), 1, 5),
    content: str(r.content, "", 400),
  };
}

const cycle = (map: Record<string, string>, cur: string) => {
  const keys = Object.keys(map);
  return keys[(keys.indexOf(cur) + 1) % keys.length];
};

/** Un bouton du panneau → nouveaux réglages */
export function applyMass(s: MassSettings, action: string, arg?: string): MassSettings {
  const n = { ...s };
  switch (action) {
    case "lang": n.lang = s.lang === "fr" ? "en" : "fr"; break;
    case "theme": n.theme = cycle(THEMES, s.theme); break;
    case "tone": n.tone = cycle(TONES, s.tone); break;
    case "len": n.length = cycle(LENGTHS, s.length); break;
    case "emo": n.emojis = cycle(EMOJIS, s.emojis); break;
    case "tease": n.tease = s.tease % 3 + 1; break;
    case "bon": n.bonuses = !s.bonuses; break;
    case "price": n.price = Math.round(clamp(s.price + (arg === "u" ? 5 : -5), 3, 500) * 100) / 100; break;
    case "old": n.oldPrice = clamp(s.oldPrice + (arg === "u" ? 50 : -50), 0, 5000); break;
    case "exp": n.expiryH = clamp(s.expiryH + (arg === "u" ? 6 : -6), 0, 168); break;
    case "var": n.variants = clamp(s.variants + (arg === "u" ? 1 : -1), 1, 5); break;
  }
  return n;
}

const money = (v: number) => `$${v.toFixed(2).replace(/\.00$/, "")}`;

export function massPanelText(s: MassSettings): string {
  return (
    "📣 PPV MASS MESSAGE\n\n" +
    `👩 Girl: ${s.girl} · ${s.lang === "fr" ? "🇫🇷 French" : "🇬🇧 English"}\n` +
    `🎭 Theme: ${s.theme === "custom" ? `✏️ ${s.customTheme || "(set it with /theme)"}` : THEMES[s.theme]}\n` +
    `🗣 Tone: ${TONES[s.tone]} · 🌶 Teasing ${"🌶".repeat(s.tease)} · 📏 ${LENGTHS[s.length]} · Emojis: ${EMOJIS[s.emojis]}\n` +
    `💰 Price ${money(s.price)}${s.oldPrice > s.price ? ` instead of ${money(s.oldPrice)}` : ""} · ⏳ ${s.expiryH ? `${s.expiryH} h` : "no deadline"} · 🎁 Bonuses: ${s.bonuses ? "on" : "off"}\n` +
    `📦 Content: ${s.content || "(not set — /info what's in the PPV)"}\n` +
    `✨ ${s.variants} version(s) per tap\n\n` +
    "Tap to change. /info <what's inside> · /theme <your theme> · /girl <name> · /fav = saved texts"
  );
}

export function massKeyboard(s: MassSettings): InlineKeyboard {
  return new InlineKeyboard()
    .text(s.lang === "fr" ? "🇫🇷 FR" : "🇬🇧 EN", "mass:lang").text(`🎭 ${THEMES[s.theme]}`, "mass:theme").row()
    .text(TONES[s.tone], "mass:tone").text(`🌶 ${s.tease}/3`, "mass:tease").text(`📏 ${LENGTHS[s.length]}`, "mass:len").row()
    .text(`Emojis: ${EMOJIS[s.emojis]}`, "mass:emo").text(`🎁 Bonuses ${s.bonuses ? "ON" : "off"}`, "mass:bon").row()
    .text("➖", "mass:price:d").text(`💰 ${money(s.price)}`, "mass:noop").text("➕", "mass:price:u").row()
    .text("➖", "mass:old:d").text(`🏷 was ${money(s.oldPrice)}`, "mass:noop").text("➕", "mass:old:u").row()
    .text("➖", "mass:exp:d").text(`⏳ ${s.expiryH} h`, "mass:noop").text("➕", "mass:exp:u").row()
    .text("➖", "mass:var:d").text(`✨ ${s.variants} versions`, "mass:noop").text("➕", "mass:var:u").row()
    .text("✨ GENERATE", "mass:go");
}

// ── Génération ─────────────────────────────────────────────────────────────
const SYSTEM = `You write paid mass messages (PPV) for an adult OnlyFans creator, sent to her subscribers.
HARD RULES — never break them:
- Suggestive and teasing, NEVER sexually explicit: no description of sex acts, no genitals, no graphic body details, no crude or vulgar words. Use innuendo, desire, mystery, anticipation ("you'll see…", "I couldn't stop thinking about you").
- She is a confident ADULT woman (25+). Never anything that suggests youth or a minor: no school, homework, teen, little girl, tiny, petite body talk, virgin, innocence play, age play, "daddy's girl".
- No violence, pain, humiliation or non-consent.
- No false claims about real people, no illegal content, nothing against OnlyFans terms.
- Keep {name} exactly as written (literally the 5 characters {name}) where the fan's first name goes; use it 1 to 3 times.
Write like a real young woman texting: natural, casual, a few typos/elongated words are ok ("sooo", "omg"), short lines. Each message must be different (angle, opening, structure).
Output ONLY a JSON array of strings, one string per message, no comments.`;

export function buildPrompt(s: MassSettings): string {
  const lang = s.lang === "fr" ? "French (natural, young, French slang from France, tutoiement)" : "English (casual US texting)";
  const theme = s.theme === "custom" ? s.customTheme || "a surprise" : THEMES[s.theme].replace(/^\S+\s/, "");
  const teasing = ["soft, sweet and flirty", "flirty and teasing, clearly sensual but classy", "very teasing and sensual, bold innuendo, still never explicit"][s.tease - 1];
  const len = { short: "2-3 short lines", medium: "4-6 short lines", long: "7-10 short lines" }[s.length];
  const emo = { few: "1-2 emojis total", normal: "a few emojis", lots: "lots of emojis" }[s.emojis];
  const offer =
    `Price: ${money(s.price)}` +
    (s.oldPrice > s.price ? ` instead of ${money(s.oldPrice)} (show the strike-through deal)` : "") +
    (s.expiryH ? `, available only ${s.expiryH} hours then deleted (urgency)` : "") +
    (s.bonuses ? ". End with a short bonus list (e.g. discount on future PPVs, VIP list, pinned chat, extra surprise) using ♡ bullets" : "");
  return (
    `Write ${s.variants} different PPV mass messages in ${lang}.\n` +
    `Creator name: ${s.girl}. Theme/angle: ${theme}. Tone: ${TONES[s.tone].replace(/^\S+\s/, "")}. Teasing level: ${teasing}.\n` +
    `Length: ${len}. Emojis: ${emo}.\n` +
    `What the PPV contains (describe it suggestively, never explicitly): ${s.content || "an exclusive spicy video of her"}.\n` +
    `${offer}.`
  );
}

// Filet de sécurité : tout texte explicite ou qui évoque une mineure est écarté
const BLOCK = [
  /\b(homework|school\s?girl|school|teen|teenage|little girl|itty|tiny|virgin|underage|daddy'?s girl|loli|barely legal)\b/i,
  /\b(devoirs|écolière|collégienne|lycéenne|petite fille|vierge|ado|mineure)\b/i,
  /\b(cock|dick|pussy|cum|fuck\w*|anal|blowjob|deepthroat|tits|titties|boobs|nipples?|dildo|clit|squirt\w*|slut\w*|whore)\b/i,
  /\b(bite|chatte|sperme|baise\w*|suce\w*|pipe|gode|seins|tétons?|salope|chienne|cul|anus|clito)\b/i,
];
export const isSafeText = (t: string) => !BLOCK.some((re) => re.test(t));

function parseVariants(raw: string): string[] {
  const m = raw.match(/\[[\s\S]*\]/);
  try {
    const arr = JSON.parse(m ? m[0] : raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  } catch {
    return [];
  }
}

async function gemini(system: string, user: string, temperature: number): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY manquante");
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature, maxOutputTokens: 4096, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(40_000),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
}

/** Génère les versions ; les textes non conformes sont écartés (2 essais). */
export async function generateMass(s: MassSettings): Promise<string[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = parseVariants(await gemini(SYSTEM, buildPrompt(s), 1.0)).filter(isSafeText);
    if (out.length) return out.slice(0, s.variants);
  }
  return [];
}

/** Traduit un texte FR ↔ EN en gardant {name}, les emojis et le style. */
export async function translateMass(text: string, to: Lang): Promise<string | null> {
  const sys =
    `Translate this OnlyFans PPV message into ${to === "fr" ? "natural young French from France (tutoiement)" : "casual US English"}. ` +
    "Keep {name} exactly, keep emojis, line breaks and the teasing style; adapt, don't translate word by word. Never make it explicit. " +
    'Output ONLY a JSON array with one string.';
  const out = parseVariants(await gemini(sys, text, 0.5)).filter(isSafeText);
  return out[0] ?? null;
}
