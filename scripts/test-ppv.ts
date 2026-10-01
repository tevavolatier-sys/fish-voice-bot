// Tests des règles PPV (prénom, tirage des vidéos, placement de la voix).
// Usage :  npx tsx scripts/test-ppv.ts
import assert from "node:assert/strict";
import {
  PPV_LINES,
  cleanFanName,
  fillLine,
  parseVideoSize,
  pickTwo,
  voiceStart,
} from "../lib/ppv.js";

assert.equal(cleanFanName("julien"), "Julien");
assert.equal(cleanFanName("  jean   marc "), "Jean marc");
assert.equal(cleanFanName("Jean-Michel"), "Jean-Michel");
assert.equal(cleanFanName("Éloïse"), "Éloïse");
assert.equal(cleanFanName("o'neil"), "O'neil");
for (const bad of ["", "J", "123", "Max2", "[moaning]", "Julien!", "a".repeat(21), "<b>x</b>"]) {
  assert.equal(cleanFanName(bad), null, bad);
}

assert.equal(
  fillLine(PPV_LINES.preview, "Julien"),
  "[soft tone] Julien… [breath] toi et moi, ça va être fou."
);
assert.ok(fillLine(PPV_LINES.paid2, "Max").trim().endsWith("Max…"));

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
console.log("tests PPV : OK");
