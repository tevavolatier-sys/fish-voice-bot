// 🎛️ Panneau de réglages PPV (/ppvsettings) et boutons sous chaque PPV.
// Textes + claviers seulement : les actions sont dans api/webhook.ts.
// Données de bouton : « cfg:… » (admin) et « ppvvol: / ppvfx: » (chatters),
// toujours ≤ 64 octets (limite Telegram).

import { InlineKeyboard } from "grammy";
import { ACTIVE_MODELS, modelByKey, modelLabel } from "./config.js";
import { EFFECT_KEYS, EFFECT_PRESETS, PPV_VOLUME_LEVELS, type EffectKey } from "./ppv.js";
import { LINE_LABELS, NAMED_KEYS, type LineKey } from "./ppv-voice.js";
import {
  NUM_PARAMS,
  fmtNum,
  getNum,
  isCustomRoom,
  numParam,
  readableLine,
  targetDbFor,
  type NumKey,
  type PpvSettings,
  type Section,
} from "./ppv-settings.js";

export type Panel = "main" | Section | "texts" | "takes";
export const PANELS: Panel[] = ["main", "effect", "volume", "voice", "timing", "texts", "takes"];
export const isPanel = (v: string): v is Panel => (PANELS as string[]).includes(v);

export const effectName = (k: EffectKey) => `${EFFECT_PRESETS[k].icon} ${EFFECT_PRESETS[k].label}`;

export function effectSummary(s: PpvSettings): string {
  return `${effectName(s.effect)}${isCustomRoom(s) ? " (tweaked)" : ""}`;
}

const val = (s: PpvSettings, key: NumKey) => fmtNum(numParam(key)!, getNum(s, key));

function voiceName(s: PpvSettings): string {
  const m = modelByKey(s.model);
  return m ? modelLabel(m) : `${s.model} (unknown → default voice)`;
}

/** Où en sont les parties fixes : « generated take » / « real recording » / « not made yet » */
export type FixedState = Partial<Record<LineKey, string>>;

export function panelText(s: PpvSettings, panel: Panel, fixed: FixedState = {}): string {
  switch (panel) {
    case "main":
      return (
        "⚙️ PPV SETTINGS — for every NEW PPV (admin only)\n\n" +
        `🎚️ Effect: ${effectSummary(s)}\n` +
        `🔊 Volume: default ${s.defaultVolume}/5 · shift ${val(s, "volumeOffsetDb")} · name ${val(s, "nameGainDb")}\n` +
        `🗣️ Voice: ${voiceName(s)} · temp ${val(s, "temperature")} · top P ${val(s, "topP")} · speed ${val(s, "speed")}\n` +
        `⏱️ Timing: PPV 1 voice at ${val(s, "paid1StartSec")} · pause ${val(s, "nameGapSec")} · PPV 2 sigh ends ${val(s, "paid2EndSec")}\n` +
        `🖤 Effect on the free preview: ${s.previewEffect ? "on" : "off"}\n\n` +
        "✍️ Texts\n" +
        (["preview", "paid1", "paid2"] as LineKey[])
          .map((k) => `${LINE_LABELS[k]}: ${readableLine(s.lines[k])}`)
          .join("\n")
      );
    case "effect":
      return (
        `🎚️ VOICE EFFECT — base: ${effectSummary(s)}\n` +
        "Tap a base effect, then fine-tune with ➖ ➕ (tap a setting's name to know what it does).\n" +
        "Chatters can also switch effect under each PPV; this one is their default.\n" +
        "Tin can sound = high Wall echoes + Presence + a narrow Bass/Treble cut.\n\n" +
        EFFECT_KEYS.map((k) => `${effectName(k)}: ${EFFECT_PRESETS[k].about}`).join("\n")
      );
    case "volume":
      return (
        "🔊 VOLUME\n" +
        "Chatters pick 1 to 5 under each PPV (their choice is remembered). Levels right now:\n" +
        Object.entries(PPV_VOLUME_LEVELS)
          .map(([lvl, cfg]) => `${cfg.icon} ${lvl}: ${targetDbFor(s, Number(lvl)).toFixed(0)} dB`)
          .join(" · ") +
        "\n(Closer to 0 dB = louder.)"
      );
    case "voice":
      return (
        `🗣️ FISH VOICE — ${voiceName(s)}\n` +
        "Used for the fans' names and for NEW takes. The saved fixed parts don't change: remake them in 🎙️ Takes.\n" +
        "PPV videos are saved per voice: send another girl's videos with the caption /ppvadd <voice>."
      );
    case "timing":
      return (
        "⏱️ TIMING & NAME\n" +
        "Where the voice lands in the videos, the pause after the name, and whether the name comes BEFORE or AFTER the fixed part."
      );
    case "texts":
      return (
        "✍️ TEXTS — the fixed part is the SAME for every fan\n\n" +
        (["preview", "paid1", "paid2"] as LineKey[])
          .map((k) => {
            const l = s.lines[k];
            return (
              `${LINE_LABELS[k]}\n  fixed: ${l.fixed}` +
              (l.name === "none" ? "  (no name)" : `\n  said as: ${l.context}`)
            );
          })
          .join("\n\n") +
        "\n\nTo change one, send:\n/ppvtext preview <new text>\n/ppvtext ppv1 <new text>\n/ppvtext ppv2 <new text>\n" +
        "Start with a tag to set the tone: [soft tone] [whispering] [sighing] [breath]…\n" +
        "The fixed part is remade with the new text automatically."
      );
    case "takes":
      return (
        "🎙️ FIXED PARTS (the takes, the same for every fan)\n" +
        "🔊 listen · 🔁 new take (replaces it now) · 🎲 3 takes (pick one with ✅)\n" +
        "Or send a REAL recording of the girl as a voice/audio with the caption /ppvfix preview, /ppvfix ppv1 or /ppvfix ppv2.\n\n" +
        (["preview", "paid1", "paid2"] as LineKey[])
          .map((k) => `${LINE_LABELS[k]}: ${fixed[k] ?? "…"}`)
          .join("\n")
      );
  }
}

function numRows(kb: InlineKeyboard, s: PpvSettings, section: Section): void {
  for (const p of NUM_PARAMS.filter((x) => x.section === section)) {
    kb.text("➖", `cfg:a:${p.key}:d`)
      .text(`${p.label}: ${fmtNum(p, getNum(s, p.key))}`, `cfg:i:${p.key}`)
      .text("➕", `cfg:a:${p.key}:u`)
      .row();
  }
}

const footer = (kb: InlineKeyboard, reset: string) =>
  kb.text(`↩️ Reset ${reset}`, `cfg:rs:${reset}`).text("⬅️ Back", "cfg:p:main");

export function panelKeyboard(s: PpvSettings, panel: Panel): InlineKeyboard {
  const kb = new InlineKeyboard();
  switch (panel) {
    case "main":
      return kb
        .text("🎚️ Effect", "cfg:p:effect").text("🔊 Volume", "cfg:p:volume").row()
        .text("🗣️ Voice", "cfg:p:voice").text("⏱️ Timing", "cfg:p:timing").row()
        .text("✍️ Texts", "cfg:p:texts").text("🎙️ Takes", "cfg:p:takes").row()
        .text("🧪 Test /ppv Julien", "cfg:test").text("🎬 Make PPV 2", "cfg:v2").row()
        .text("↩️ Reset everything", "cfg:rall");
    case "effect":
      EFFECT_KEYS.forEach((k, i) => {
        kb.text(`${k === s.effect ? "✅ " : ""}${effectName(k)}`, `cfg:fx:${k}`);
        if (i % 3 === 2) kb.row();
      });
      kb.row();
      numRows(kb, s, "effect");
      kb.text(`🖤 Effect on the preview: ${s.previewEffect ? "ON" : "off"}`, "cfg:pv").row();
      return footer(kb, "effect");
    case "volume":
      numRows(kb, s, "volume");
      return footer(kb, "volume");
    case "voice":
      ACTIVE_MODELS.forEach((m, i) => {
        kb.text(`${m.key === s.model ? "✅ " : ""}${modelLabel(m)}`, `cfg:md:${m.key}`);
        if (i % 2 === 1) kb.row();
      });
      kb.row();
      numRows(kb, s, "voice");
      return footer(kb, "voice");
    case "timing":
      numRows(kb, s, "timing");
      for (const k of NAMED_KEYS) {
        const pos = s.lines[k].name;
        kb.text(`${LINE_LABELS[k]} name:`, "cfg:i:namepos")
          .text(`${pos === "before" ? "✅ " : ""}before`, `cfg:np:${k}:b`)
          .text(`${pos === "after" ? "✅ " : ""}after`, `cfg:np:${k}:a`)
          .row();
      }
      return footer(kb, "timing");
    case "texts":
      return footer(kb, "texts");
    case "takes":
      for (const k of ["preview", "paid1", "paid2"] as LineKey[]) {
        kb.text(`🔊 ${LINE_LABELS[k]}`, `ppvhear:${k}`)
          .text("🔁 New", `ppvfix:${k}`)
          .text("🎲 3 takes", `ppvcand:${k}`)
          .row();
      }
      return kb.text("⬅️ Back", "cfg:p:main");
  }
}

export const confirmResetKeyboard = () =>
  new InlineKeyboard()
    .text("⚠️ Yes, reset EVERYTHING", "cfg:rall!")
    .row()
    .text("Cancel", "cfg:p:main");

// ── Sous chaque PPV : volume 1 → 5 + effet (refait la vidéo, même voix) ──────
export function ppvControlsKeyboard(token: string, level: number, effect: EffectKey): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const [lvl, cfg] of Object.entries(PPV_VOLUME_LEVELS)) {
    kb.text(`${Number(lvl) === level ? "✅ " : ""}${cfg.icon} ${lvl}`, `ppvvol:${token}:${lvl}`);
  }
  kb.row();
  EFFECT_KEYS.forEach((k, i) => {
    kb.text(`${k === effect ? "✅ " : ""}${effectName(k)}`, `ppvfx:${token}:${k}`);
    if (i % 3 === 2) kb.row();
  });
  return kb;
}

export function ppvControlsText(level: number, effect: EffectKey): string {
  return (
    `🔊 Volume ${level}/5 · 🎚️ ${effectName(effect)}\n` +
    "Too loud, too quiet, sounds fake? Tap a volume or an effect: I remake the PPV 1 video with the SAME voice (your choice is remembered)."
  );
}
