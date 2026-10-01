// PPV 2 = la MÊME vidéo pour tous les fans (pas de prénom) : on pose une fois
// la partie fixe choisie (prise « PPV2-A2 », « Mmmh… ») dans la vidéo pleine
// qualité (4K : trop lourde pour Telegram, d'où ce script ; en 1080p le bot
// le fait lui-même : ⚙️ /ppvsettings → 🎬 Make PPV 2). Même effet et même
// volume que le bot. Le fichier obtenu va directement dans le vault.
// Usage : npx tsx scripts/vault-ppv2.ts <vidéo> <audio de la partie fixe> <sortie.mp4> [volume 1-5] [effet]
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { EFFECT_KEYS, isEffectKey, mixVoiceIntoVideo } from "../lib/ppv.js";
import { defaultSettings, roomFor, targetDbFor } from "../lib/ppv-settings.js";
import { ffmpegBinary, run } from "../lib/video.js";

const [VIDEO, VOICE, OUT, LEVEL, EFFECT] = process.argv.slice(2);
const CFG = defaultSettings();
if (!VIDEO || !VOICE || !OUT || (EFFECT && !isEffectKey(EFFECT))) {
  console.error(
    `Usage : npx tsx scripts/vault-ppv2.ts <vidéo> <audio> <sortie.mp4> [volume 1-5] [${EFFECT_KEYS.join("|")}]`
  );
  process.exit(1);
}
const level = Number(LEVEL ?? CFG.defaultVolume);
const effect = isEffectKey(EFFECT) ? EFFECT : CFG.effect;

async function main() {
  const out = await mixVoiceIntoVideo(
    readFileSync(VIDEO),
    readFileSync(VOICE),
    { mode: "end", before: CFG.paid2EndSec }, // le soupir finit 0,6 s avant la fin
    targetDbFor(CFG, level),
    undefined,
    undefined,
    roomFor(CFG, effect)
  );
  const tmp = `${OUT}.tmp.mp4`;
  writeFileSync(tmp, out.video);
  const bin = await ffmpegBinary();
  const hevc = /Video: hevc/.test((await run(bin, ["-hide_banner", "-i", tmp])).stderr);
  // Étiquette « hvc1 » : sans elle, iPhone / QuickTime ne lisent pas le HEVC
  const r = await run(bin, [
    "-y", "-hide_banner", "-i", tmp, "-c", "copy", ...(hevc ? ["-tag:v", "hvc1"] : []),
    "-movflags", "+faststart", OUT,
  ]);
  unlinkSync(tmp);
  if (r.code !== 0) throw new Error(r.stderr.slice(-400));
  console.log(`✔ ${OUT} · ${out.width}×${out.height} · ${out.duration} s · volume ${level}/5 · ${effect}`);
}

main().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
