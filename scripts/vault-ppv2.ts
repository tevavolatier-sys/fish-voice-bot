// PPV 2 = la MÊME vidéo pour tous les fans (pas de prénom) : on pose une fois
// la partie fixe choisie (prise « PPV2-A2 », « Mmmh… ») dans la vidéo pleine
// qualité, avec le même rendu « pièce » et le même volume que le bot. Le
// fichier obtenu va directement dans le vault OnlyFans.
// Usage : npx tsx scripts/vault-ppv2.ts <vidéo> <audio de la partie fixe> <sortie.mp4> [volume 1-5]
import { readFileSync, writeFileSync } from "node:fs";
import { mixVoiceIntoVideo, ppvTargetDb, PPV_DEFAULT_VOLUME } from "../lib/ppv.js";
import { ffmpegBinary, run } from "../lib/video.js";

const [VIDEO, VOICE, OUT, LEVEL] = process.argv.slice(2);
if (!VIDEO || !VOICE || !OUT) {
  console.error("Usage : npx tsx scripts/vault-ppv2.ts <vidéo> <audio> <sortie.mp4> [volume 1-5]");
  process.exit(1);
}
const level = Number(LEVEL ?? PPV_DEFAULT_VOLUME);

async function main() {
  const out = await mixVoiceIntoVideo(
    readFileSync(VIDEO),
    readFileSync(VOICE),
    { mode: "end", before: 0.6 }, // le soupir finit 0,6 s avant la fin
    ppvTargetDb(level)
  );
  const tmp = `${OUT}.tmp.mp4`;
  writeFileSync(tmp, out.video);
  // Étiquette « hvc1 » : sans elle, iPhone / QuickTime ne lisent pas le HEVC
  const r = await run(await ffmpegBinary(), [
    "-y", "-hide_banner", "-i", tmp, "-c", "copy", "-tag:v", "hvc1", "-movflags", "+faststart", OUT,
  ]);
  if (r.code !== 0) throw new Error(r.stderr.slice(-400));
  console.log(`✔ ${OUT} · ${out.width}×${out.height} · ${out.duration} s · volume ${level}/5`);
}

main().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
