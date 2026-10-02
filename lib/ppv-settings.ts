// ⚙️ RÉGLAGES PPV : tout ce qui façonne les PPV, modifiable depuis le bot
// (/ppvsettings, admin). Gardés dans Redis ; ce qui manque reprend la valeur
// par défaut et ce qui sort des bornes y est ramené : un réglage abîmé ne
// peut jamais casser un PPV.

import type { VoiceOptions } from "./fish.js";
import {
  DEFAULT_EFFECT,
  EFFECT_PRESETS,
  PPV_DEFAULT_MODEL,
  PPV_DEFAULT_VOLUME,
  PPV_VOLUME_LEVELS,
  isEffectKey,
  type EffectKey,
  type RoomParams,
} from "./ppv.js";
import { LINE_KEYS, NAME_GAP_SEC, type LineKey } from "./ppv-voice.js";

export type NamePos = "before" | "after";

export interface PpvLine {
  /** Partie fixe, la même pour tous les fans (tags Fish compris) */
  fixed: string;
  /** Phrase complète avec {name} : donne au prénom sa bonne intonation */
  context: string;
  /** Place du prénom ; « none » = pas de prénom (PPV 2) */
  name: NamePos | "none";
}

export interface PpvSettings {
  model: string; // voix Fish des PPV (clé de lib/config.ts)
  effect: EffectKey; // effet de base
  room: RoomParams; // effet réellement appliqué (base + retouches)
  volumeOffsetDb: number; // décale les 5 niveaux de volume
  defaultVolume: number; // niveau d'un chatter qui n'a rien choisi
  nameGainDb: number; // prénom plus fort / plus doux que la partie fixe
  temperature: number;
  topP: number;
  speed: number;
  previewStartSec: number; // début de la voix dans la vidéo de preview
  paid1StartSec: number; // début de la voix dans la vidéo PPV 1
  nameGapSec: number; // pause entre le prénom et la partie fixe
  paid2EndSec: number; // le soupir du PPV 2 finit à X s de la fin
  previewEffect: boolean; // effet aussi sur la preview fond noir
  lines: Record<LineKey, PpvLine>;
}

export const DEFAULT_LINES: Record<LineKey, PpvLine> = {
  preview: {
    // Texte de Teva le 2026-10-02 (preview = vidéo IMG_2904, 9 premières s)
    // Style « avec souffle » choisi le 2026-10-02 : le souffle vient APRÈS
    // le prénom, sinon il serait pris pour le prénom (et le prénom perdu)
    fixed: "[soft tone] [breath] n'oublie pas, il faut tenir jusqu'au bout…",
    context: "[soft tone] {name}… [breath] n'oublie pas, il faut tenir jusqu'au bout…",
    name: "before",
  },
  paid1: {
    // Prise « PPV1-A1 » choisie par Teva le 2026-10-01, prénom AU DÉBUT
    fixed: "[soft tone] Hmm, c'est chaud.",
    context: "[soft tone] {name}… Hmm, c'est chaud.",
    name: "before",
  },
  paid2: {
    // Prise « PPV2-A2 » choisie le 2026-10-01, sans prénom
    fixed: "[sighing] Mmmh…",
    context: "",
    name: "none",
  },
};

/** Texte d'où viennent les prises enregistrées AVANT le champ `t` */
export const LEGACY_FIXED_TEXT: Record<LineKey, string> = {
  preview: "[soft tone] toi et moi, ça va être fou.",
  paid1: "[soft tone] Hmm, c'est chaud, toi et moi.",
  paid2: "[sighing] Hmmm… [breath] [groaning] mmmh… [panting]",
};

export function defaultSettings(): PpvSettings {
  return {
    model: PPV_DEFAULT_MODEL,
    effect: DEFAULT_EFFECT,
    room: { ...EFFECT_PRESETS[DEFAULT_EFFECT].params },
    volumeOffsetDb: 0,
    defaultVolume: PPV_DEFAULT_VOLUME,
    nameGainDb: 2, // prénom un peu au-dessus : bien audible
    temperature: 0.55,
    topP: 0.7,
    speed: 1,
    previewStartSec: 0.5,
    paid1StartSec: 1.5,
    nameGapSec: NAME_GAP_SEC.before,
    paid2EndSec: 0.6,
    previewEffect: false,
    lines: {
      preview: { ...DEFAULT_LINES.preview },
      paid1: { ...DEFAULT_LINES.paid1 },
      paid2: { ...DEFAULT_LINES.paid2 },
    },
  };
}

// ── Réglages chiffrés (boutons ➖ / ➕) ──────────────────────────────────────
export type Section = "effect" | "volume" | "voice" | "timing";
type RoomKey = keyof RoomParams;
export type NumKey =
  | `room.${RoomKey}`
  | "volumeOffsetDb"
  | "defaultVolume"
  | "nameGainDb"
  | "temperature"
  | "topP"
  | "speed"
  | "previewStartSec"
  | "paid1StartSec"
  | "nameGapSec"
  | "paid2EndSec";

export interface NumParam {
  key: NumKey;
  section: Section;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  help: string;
}

export const NUM_PARAMS: NumParam[] = [
  { key: "room.highpass", section: "effect", label: "Bass cut", unit: " Hz", min: 20, max: 300, step: 10,
    help: "Removes the lows below this. Higher = thinner, more 'phone'. 20 = off." },
  { key: "room.lowpass", section: "effect", label: "Treble cut", unit: " Hz", min: 3000, max: 20000, step: 500,
    help: "Softens the highs above this. Lower = duller, further away. 20000 = off." },
  { key: "room.warmthDb", section: "effect", label: "Warmth", unit: " dB", min: -6, max: 6, step: 0.5,
    help: "Body around 180 Hz. More = warmer, fuller voice." },
  { key: "room.boomCutDb", section: "effect", label: "Boom cut", unit: " dB", min: -9, max: 3, step: 0.5,
    help: "Around 250 Hz. Lower = less boomy, less 'mouth on the mic'." },
  { key: "room.presenceDb", section: "effect", label: "Presence", unit: " dB", min: -6, max: 6, step: 0.5,
    help: "Around 2.5 kHz. More = clearer but more 'phone' / tin can." },
  { key: "room.compression", section: "effect", label: "Compression", unit: "", min: 0, max: 3, step: 1,
    help: "0 off · 1 soft · 2 medium · 3 strong. Evens loud and soft parts, like a phone mic." },
  { key: "room.reflections", section: "effect", label: "Wall echoes", unit: "", min: 0, max: 1, step: 0.05,
    help: "Very short echoes from close walls. Above ~0.5 = tin can sound. 0 = none." },
  { key: "room.reverb", section: "effect", label: "Room reverb", unit: "", min: 0, max: 0.3, step: 0.01,
    help: "Level of the room's tail. More = more echo." },
  { key: "room.reverbSec", section: "effect", label: "Reverb length", unit: " s", min: 0.1, max: 1.5, step: 0.05,
    help: "How long the room's tail lasts." },
  { key: "room.width", section: "effect", label: "Stereo width", unit: "", min: 0, max: 1, step: 0.1,
    help: "0 = mono, in the center · 1 = wide, like the 2 mics of an iPhone." },
  { key: "volumeOffsetDb", section: "volume", label: "Shift all levels", unit: " dB", min: -15, max: 15, step: 1,
    help: "Moves the 5 volume levels up or down together (for every chatter)." },
  { key: "defaultVolume", section: "volume", label: "Default level", unit: "/5", min: 1, max: 5, step: 1,
    help: "Level for a chatter who never tapped a volume button." },
  { key: "nameGainDb", section: "volume", label: "Name volume", unit: " dB", min: -6, max: 6, step: 0.5,
    help: "The fan's name louder (+) or softer (−) than the fixed part." },
  { key: "temperature", section: "voice", label: "Temperature", unit: "", min: 0.1, max: 1, step: 0.05,
    help: "Lower = steadier, more predictable. Higher = more expressive, riskier." },
  { key: "topP", section: "voice", label: "Top P", unit: "", min: 0.1, max: 1, step: 0.05,
    help: "Lower = steadier. Works together with temperature." },
  { key: "speed", section: "voice", label: "Speed", unit: "×", min: 0.7, max: 1.3, step: 0.05,
    help: "Speaking speed of the names and of NEW takes." },
  { key: "previewStartSec", section: "timing", label: "Preview voice at", unit: " s", min: 0, max: 8, step: 0.25,
    help: "Where the voice starts in the free preview video (long names; short names start a bit later)." },
  { key: "paid1StartSec", section: "timing", label: "PPV 1 voice at", unit: " s", min: 0, max: 15, step: 0.25,
    help: "Where the voice starts in the PPV 1 video (long names). Short names start a bit later, so the fixed part always lands at the same moment." },
  { key: "nameGapSec", section: "timing", label: "Pause after name", unit: " s", min: 0.05, max: 0.8, step: 0.05,
    help: "Silence between the fan's name and the fixed part." },
  { key: "paid2EndSec", section: "timing", label: "PPV 2 sigh ends", unit: " s before end", min: 0, max: 10, step: 0.1,
    help: "The PPV 2 sigh finishes this long before the end of the video." },
];

export const numParam = (key: string): NumParam | undefined =>
  NUM_PARAMS.find((p) => p.key === key);

export function getNum(s: PpvSettings, key: NumKey): number {
  if (key.startsWith("room.")) return s.room[key.slice(5) as RoomKey];
  return s[key as Exclude<NumKey, `room.${RoomKey}`>];
}

function setNum(s: PpvSettings, key: NumKey, v: number): void {
  if (key.startsWith("room.")) s.room[key.slice(5) as RoomKey] = v;
  else s[key as Exclude<NumKey, `room.${RoomKey}`>] = v;
}

const decimals = (step: number) => (String(step).split(".")[1] ?? "").length;

function fit(p: NumParam, v: number): number {
  const clamped = Math.min(p.max, Math.max(p.min, v));
  return Number(clamped.toFixed(decimals(p.step)));
}

export function fmtNum(p: NumParam, v: number): string {
  const d = decimals(p.step);
  const sign = p.unit.trim() === "dB" && v > 0 ? "+" : "";
  return `${sign}${v.toFixed(d)}${p.unit}`;
}

const clone = (s: PpvSettings): PpvSettings => JSON.parse(JSON.stringify(s)) as PpvSettings;

/** Un cran de plus (dir = 1) ou de moins (dir = −1), borné. */
export function adjustNum(s: PpvSettings, key: NumKey, dir: 1 | -1): PpvSettings {
  const p = numParam(key);
  if (!p) return s;
  const next = clone(s);
  setNum(next, key, fit(p, getNum(s, key) + dir * p.step));
  return next;
}

/** Effet de base : remplace toutes les retouches de l'effet. */
export function applyPreset(s: PpvSettings, effect: EffectKey): PpvSettings {
  const next = clone(s);
  next.effect = effect;
  next.room = { ...EFFECT_PRESETS[effect].params };
  return next;
}

export function isCustomRoom(s: PpvSettings): boolean {
  const base = EFFECT_PRESETS[s.effect].params;
  return (Object.keys(base) as RoomKey[]).some((k) => Math.abs(base[k] - s.room[k]) > 1e-9);
}

/** Effet choisi par un chatter → paramètres (l'effet de base garde ses retouches). */
export function roomFor(s: PpvSettings, effect?: EffectKey | null): RoomParams {
  if (!effect || effect === s.effect) return s.room;
  return EFFECT_PRESETS[effect].params;
}

export function voiceOpts(s: PpvSettings): VoiceOptions {
  return { temperature: s.temperature, top_p: s.topP, speed: s.speed };
}

/** Niveau moyen visé (dB) pour un niveau de volume 1 → 5. */
export function targetDbFor(s: PpvSettings, level: number): number {
  const lvl = PPV_VOLUME_LEVELS[level] ?? PPV_VOLUME_LEVELS[s.defaultVolume];
  return lvl.db + s.volumeOffsetDb;
}

// ── Textes ──────────────────────────────────────────────────────────────────
const TAGS_RE = /^\s*((?:\[[^\]]*\]\s*)*)([\s\S]*)$/;

function splitTags(text: string): { tags: string; body: string } {
  const m = text.match(TAGS_RE)!;
  return { tags: m[1].trim(), body: m[2].trim() };
}

/** Phrase complète dite par le clone pour un prénom bien intoné. */
// Souffles, soupirs… : jamais devant le prénom (on les prendrait pour lui)
const BREATHY = /breath|sigh|inhale|exhale|pant|moan|gasp/i;

export function deriveContext(fixed: string, pos: NamePos): string {
  const { tags, body } = splitTags(fixed);
  const lead = tags ? `${tags} ` : "";
  if (pos === "before") {
    const all = tags.match(/\[[^\]]*\]/g) ?? [];
    const front = all.filter((t) => !BREATHY.test(t)).join(" ");
    const after = all.filter((t) => BREATHY.test(t)).join(" ");
    return `${front ? `${front} ` : ""}{name}… ${after ? `${after} ` : ""}${body}`;
  }
  return `${lead}${body.replace(/[\s.!?…,;:]+$/u, "")}… {name}.`;
}

/** Repli : le prénom seul, avec le 1er tag de la phrase (sinon [soft tone]). */
export function nameAloneFor(s: PpvSettings, key: LineKey): string {
  const first = splitTags(s.lines[key].fixed).tags.match(/^\[[^\]]*\]/)?.[0] ?? "[soft tone]";
  return `${first} {name}…`;
}

/** Texte lisible (sans tags) : « [prénom]… toi et moi, ça va être fou. » */
export function readableLine(line: PpvLine): string {
  const plain = line.fixed.replace(/\[[^\]]*\]\s*/g, "").trim();
  if (line.name === "before") return `[name]… ${plain}`;
  if (line.name === "after") return `${plain.replace(/[\s.!?…,;:]+$/u, "")}… [name].`;
  return plain;
}

const TEXT_MAX = 200;

/** Nouveau texte de partie fixe. null si inutilisable (vide, trop long…). */
export function setLineText(s: PpvSettings, key: LineKey, text: string): PpvSettings | null {
  const clean = text.replace(/\{name\}/gi, "").replace(/\s+/g, " ").trim();
  if (clean.length < 2 || clean.length > TEXT_MAX) return null;
  if (!/\p{L}/u.test(splitTags(clean).body)) return null; // il faut des mots
  const next = clone(s);
  const line = next.lines[key];
  line.fixed = clean;
  line.context = line.name === "none" ? "" : deriveContext(clean, line.name);
  return next;
}

export function setNamePos(s: PpvSettings, key: LineKey, pos: NamePos): PpvSettings {
  if (s.lines[key].name === "none") return s;
  const next = clone(s);
  next.lines[key].name = pos;
  next.lines[key].context = deriveContext(next.lines[key].fixed, pos);
  return next;
}

// ── Lecture depuis Redis ────────────────────────────────────────────────────
/** Réglages lus (JSON quelconque) → réglages complets et valides. */
export function normalizeSettings(raw: unknown): PpvSettings {
  const d = defaultSettings();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  if (typeof r.model === "string" && /^[a-z0-9_-]{1,30}$/i.test(r.model)) d.model = r.model;
  if (isEffectKey(r.effect)) {
    d.effect = r.effect;
    d.room = { ...EFFECT_PRESETS[r.effect].params };
  }
  if (r.room && typeof r.room === "object") {
    const room = r.room as Record<string, unknown>;
    for (const k of Object.keys(d.room) as RoomKey[]) {
      const v = room[k];
      if (typeof v === "number" && Number.isFinite(v)) d.room[k] = v;
    }
  }
  for (const p of NUM_PARAMS) {
    if (!p.key.startsWith("room.")) {
      const v = r[p.key];
      if (typeof v === "number" && Number.isFinite(v)) setNum(d, p.key, v);
    }
    setNum(d, p.key, fit(p, getNum(d, p.key)));
  }
  if (typeof r.previewEffect === "boolean") d.previewEffect = r.previewEffect;
  if (r.lines && typeof r.lines === "object") {
    const lines = r.lines as Record<string, unknown>;
    for (const key of LINE_KEYS) {
      const l = lines[key] as Partial<PpvLine> | undefined;
      if (!l || typeof l.fixed !== "string" || !l.fixed.trim()) continue;
      const fixed = l.fixed.trim().slice(0, TEXT_MAX);
      if (key === "paid2") {
        d.lines.paid2 = { fixed, context: "", name: "none" };
        continue;
      }
      const name: NamePos = l.name === "after" ? "after" : "before";
      const context =
        typeof l.context === "string" && l.context.includes("{name}")
          ? l.context
          : deriveContext(fixed, name);
      d.lines[key] = { fixed, context, name };
    }
  }
  return d;
}

// ── Remise à zéro par rubrique ──────────────────────────────────────────────
export type ResetPart = Section | "texts" | "all";

export function resetPart(s: PpvSettings, part: ResetPart): PpvSettings {
  const d = defaultSettings();
  if (part === "all") return d;
  const next = clone(s);
  if (part === "effect") {
    next.effect = d.effect;
    next.room = d.room;
    next.previewEffect = d.previewEffect;
  } else if (part === "volume") {
    next.volumeOffsetDb = d.volumeOffsetDb;
    next.defaultVolume = d.defaultVolume;
    next.nameGainDb = d.nameGainDb;
  } else if (part === "voice") {
    next.model = d.model;
    next.temperature = d.temperature;
    next.topP = d.topP;
    next.speed = d.speed;
  } else if (part === "timing") {
    next.previewStartSec = d.previewStartSec;
    next.paid1StartSec = d.paid1StartSec;
    next.nameGapSec = d.nameGapSec;
    next.paid2EndSec = d.paid2EndSec;
    for (const key of LINE_KEYS) {
      const line = next.lines[key];
      const def = DEFAULT_LINES[key];
      if (line.name === "none") continue;
      line.name = def.name;
      line.context =
        line.fixed === def.fixed ? def.context : deriveContext(line.fixed, def.name as NamePos);
    }
  } else if (part === "texts") {
    next.lines = d.lines;
  }
  return next;
}
