// Tests des règles PPV (prénom, tirage des vidéos, placement de la voix).
// Usage :  npx tsx scripts/test-ppv.ts
import assert from "node:assert/strict";
import {
  EFFECT_KEYS,
  EFFECT_PRESETS,
  cleanFanName,
  fillLine,
  parseVideoSize,
  pickTwo,
  voiceStart,
} from "../lib/ppv.js";
import { parseSilences, pickNameSpan, voicedSpans } from "../lib/ppv-voice.js";
import {
  DEFAULT_LINES,
  NUM_PARAMS,
  adjustNum,
  applyPreset,
  defaultSettings,
  deriveContext,
  getNum,
  isCustomRoom,
  nameAloneFor,
  normalizeSettings,
  readableLine,
  resetPart,
  roomFor,
  setLineText,
  setNamePos,
  targetDbFor,
} from "../lib/ppv-settings.js";
import { PANELS, panelKeyboard, ppvControlsKeyboard } from "../lib/ppv-panel.js";

assert.equal(cleanFanName("julien"), "Julien");
assert.equal(cleanFanName("  jean   marc "), "Jean marc");
assert.equal(cleanFanName("Jean-Michel"), "Jean-Michel");
assert.equal(cleanFanName("Éloïse"), "Éloïse");
assert.equal(cleanFanName("o'neil"), "O'neil");
for (const bad of ["", "J", "123", "Max2", "[moaning]", "Julien!", "a".repeat(21), "<b>x</b>"]) {
  assert.equal(cleanFanName(bad), null, bad);
}

assert.equal(
  fillLine(DEFAULT_LINES.preview.context, "Julien"),
  "[soft tone] Julien… n'oublie pas, il faut tenir jusqu'au bout…"
);
assert.ok(fillLine(DEFAULT_LINES.paid1.context, "Max").startsWith("[soft tone] Max… "));

for (let i = 0; i < 2000; i++) {
  const [a, b] = pickTwo(5);
  assert.ok(a !== b && a >= 0 && a < 5 && b >= 0 && b < 5);
}
const seen = new Set<string>();
for (let i = 0; i < 5000; i++) seen.add(pickTwo(5).join("-"));
assert.equal(seen.size, 20); // toutes les paires possibles sortent
assert.throws(() => pickTwo(1));

assert.equal(voiceStart(24, 3, { mode: "start", at: 1.5 }), 1.5);
assert.equal(voiceStart(24, 3, { mode: "end", before: 0.6 }), 20.4);
assert.equal(voiceStart(2, 3, { mode: "start", at: 1.5 }), 0);
assert.equal(voiceStart(4, 3, { mode: "start", at: 1.5 }), 0.8);

assert.deepEqual(
  parseVideoSize(
    "  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 1920x1080, 4386 kb/s, 60 fps"
  ),
  { width: 1920, height: 1080 }
);
// Découpe du prénom : silences → parties parlées → prénom (1re ou dernière)
const stderr = [
  "[silencedetect @ 0x1] silence_start: 0",
  "[silencedetect @ 0x1] silence_end: 0.18 | silence_duration: 0.18",
  "[silencedetect @ 0x1] silence_start: 2.9",
  "[silencedetect @ 0x1] silence_end: 3.3 | silence_duration: 0.4",
  "[silencedetect @ 0x1] silence_start: 4.1",
].join("\n");
const sil = parseSilences(stderr, 4.4);
assert.deepEqual(sil, [
  { start: 0, end: 0.18 },
  { start: 2.9, end: 3.3 },
  { start: 4.1, end: 4.4 },
]);
const spans = voicedSpans(sil, 4.4);
assert.deepEqual(spans, [
  { start: 0.18, end: 2.9 },
  { start: 3.3, end: 4.1 },
]);
// « … c'est chaud, toi et moi… Julien » : le prénom = dernière partie parlée
assert.deepEqual(pickNameSpan(spans, "after", 4.4), { start: 3.26, end: 4.14 });
// « Julien… toi et moi » : 1re partie parlée, trop longue ici → refus (repli)
assert.equal(pickNameSpan(spans, "before", 4.4), null);
// Pas de pause du tout : impossible d'isoler le prénom
assert.equal(pickNameSpan([{ start: 0, end: 3 }], "after", 3), null);

// ── Réglages ──────────────────────────────────────────────────────────────
const d = defaultSettings();
assert.deepEqual(normalizeSettings(null), d);
assert.deepEqual(normalizeSettings("n'importe quoi"), d);
assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(d))), d); // aller-retour Redis
// Valeurs hors bornes ramenées dedans, valeurs absurdes ignorées
const wild = normalizeSettings({
  effect: "iphone",
  room: { highpass: 99999, reverb: "beaucoup", width: -3 },
  volumeOffsetDb: 400,
  defaultVolume: 9,
  temperature: Number.NaN,
  previewEffect: "oui",
  model: "../../etc",
  lines: { paid1: { fixed: "  [whispering] Viens.  ", name: "after", context: "sans prénom" }, paid2: { fixed: "" } },
});
assert.equal(wild.effect, "iphone");
assert.equal(wild.room.highpass, 300);
assert.equal(wild.room.reverb, EFFECT_PRESETS.iphone.params.reverb);
assert.equal(wild.room.width, 0);
assert.equal(wild.volumeOffsetDb, 15);
assert.equal(wild.defaultVolume, 5);
assert.equal(wild.temperature, d.temperature);
assert.equal(wild.previewEffect, false);
assert.equal(wild.model, d.model);
assert.deepEqual(wild.lines.paid1, { fixed: "[whispering] Viens.", context: "[whispering] Viens… {name}.", name: "after" });
assert.deepEqual(wild.lines.paid2, DEFAULT_LINES.paid2);
// Les effets de base sont dans les bornes des réglages (sinon ils seraient déformés)
for (const k of EFFECT_KEYS) {
  const s = applyPreset(d, k);
  assert.equal(isCustomRoom(normalizeSettings(s)), false, k);
}
// ➖ / ➕ : un cran, bornés, sans erreur d'arrondi
let s = d;
for (let i = 0; i < 50; i++) s = adjustNum(s, "room.reflections", 1);
assert.equal(s.room.reflections, 1);
s = adjustNum(adjustNum(d, "room.warmthDb", 1), "room.warmthDb", 1);
assert.equal(s.room.warmthDb, 3);
assert.equal(isCustomRoom(s), true);
assert.equal(d.room.warmthDb, 2); // l'original n'est pas modifié
for (let i = 0; i < 30; i++) s = adjustNum(s, "temperature", -1);
assert.equal(s.temperature, 0.1);
for (const p of NUM_PARAMS) {
  const up = adjustNum(d, p.key, 1);
  assert.ok(getNum(up, p.key) <= p.max && getNum(up, p.key) >= p.min, p.key);
}
// Effet d'un chatter : l'effet de base garde ses retouches, les autres non
assert.equal(roomFor(s, s.effect), s.room);
assert.deepEqual(roomFor(s, "iphone"), EFFECT_PRESETS.iphone.params);
assert.equal(targetDbFor(d, 2), -55);
assert.equal(targetDbFor(adjustNum(d, "volumeOffsetDb", -1), 2), -56);
// Textes : le prénom avant / après, les tags gardés
assert.equal(deriveContext("[soft tone] Hmm, c'est chaud.", "before"), "[soft tone] {name}… Hmm, c'est chaud.");
assert.equal(deriveContext("[soft tone] Hmm, c'est chaud.", "after"), "[soft tone] Hmm, c'est chaud… {name}.");
assert.equal(nameAloneFor(d, "paid1"), "[soft tone] {name}…");
const t = setLineText(d, "paid1", "[whispering] {name} viens  ici ");
assert.ok(t);
assert.equal(t!.lines.paid1.fixed, "[whispering] viens ici");
assert.equal(t!.lines.paid1.context, "[whispering] {name}… viens ici");
assert.equal(setLineText(d, "paid1", "[sighing]"), null);
assert.equal(setLineText(d, "paid1", "x".repeat(300)), null);
assert.equal(setLineText(d, "paid2", "[sighing] Ahh…")!.lines.paid2.context, "");
assert.equal(readableLine(d.lines.paid1), "[name]… Hmm, c'est chaud.");
assert.equal(readableLine(setNamePos(d, "paid1", "after").lines.paid1), "Hmm, c'est chaud… [name].");
assert.equal(setNamePos(d, "paid2", "after"), d); // PPV 2 : jamais de prénom
// Remise à zéro : le texte par défaut retrouve sa phrase d'origine
assert.deepEqual(resetPart(setNamePos(d, "preview", "after"), "timing").lines.preview, DEFAULT_LINES.preview);
assert.deepEqual(resetPart(t!, "texts").lines, d.lines);
assert.deepEqual(resetPart(s, "all"), d);
// Boutons Telegram : données ≤ 64 octets, partout
const keyboards = [
  ...PANELS.map((p) => panelKeyboard(s, p)),
  ppvControlsKeyboard("abcdef0123456789", 5, "bedroom"),
];
for (const kb of keyboards) {
  for (const row of kb.inline_keyboard) {
    for (const b of row) {
      const data = "callback_data" in b ? String(b.callback_data) : "";
      assert.ok(Buffer.byteLength(data) <= 64, data);
      assert.ok(data.length > 0, JSON.stringify(b));
    }
  }
}

console.log("tests PPV : OK");
