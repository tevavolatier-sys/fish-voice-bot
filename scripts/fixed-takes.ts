// Atelier de la PARTIE FIXE du PPV 1 : génère plusieurs prises courtes, les
// assemble avec un prénom test placé AU DÉBUT (comme le bot), les pose dans la
// vraie vidéo (rendu « pièce », volume 2) et en sort un EXTRAIT court centré
// sur la voix, pour choisir à l'oreille. La prise choisie s'installe ensuite
// dans le bot (porte d'admin ?setup=fixed&line=paid1, ou /ppvfix ppv1).
// Usage : FISH_API_KEY=… npx tsx scripts/fixed-takes.ts <vidéo PPV 1 en 1080p> <dossier de sortie>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateVoice } from "../lib/fish.js";
import { NAME_MAX_SEC, extractNameAudio, joinFixedAndName } from "../lib/ppv-voice.js";
import { mixVoiceIntoVideo, roomVoice } from "../lib/ppv.js";
import { defaultSettings, targetDbFor, voiceOpts } from "../lib/ppv-settings.js";
import { ffmpegBinary, parseInputDuration, run } from "../lib/video.js";

const SIENNA = "aa13d26cfc6e41f1b1f7a02bf5baa606";
const NAME = "Julien";
const [VIDEO, OUT] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
// Réglages par défaut du bot (effet, volume 2, voix, calage)
const CFG = defaultSettings();
const PPV_VOICE_OPTS = voiceOpts(CFG);

// id → partie fixe ; le prénom est pris dans « {prénom}… » + cette partie fixe
const VARIANTS: { id: string; fixed: string }[] = [
  { id: "A", fixed: "[soft tone] Hmm, c'est chaud, toi et moi." },
  { id: "B", fixed: "[whispering] Hmm, c'est chaud, toi et moi." },
];
const TAKES = 2;

async function seconds(buf: Buffer): Promise<number> {
  const f = join(OUT, "_probe.audio");
  writeFileSync(f, buf);
  return parseInputDuration((await run(await ffmpegBinary(), ["-hide_banner", "-i", f])).stderr) ?? 0;
}

// Extrait court (vidéo réencodée en 720p pour l'écoute) autour de la voix
async function clip(video: Buffer, from: number, len: number, out: string) {
  const inp = join(OUT, "_full.mp4");
  writeFileSync(inp, video);
  const r = await run(await ffmpegBinary(), [
    "-y", "-hide_banner", "-ss", from.toFixed(2), "-t", len.toFixed(2), "-i", inp,
    "-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out,
  ]);
  if (r.code !== 0) throw new Error(r.stderr.slice(-300));
}

async function main() {
  const videoBuf = readFileSync(VIDEO);
  for (const v of VARIANTS) {
    for (let take = 1; take <= TAKES; take++) {
      const label = `PPV1-${v.id}${take}`;
      const fixed = await generateVoice(v.fixed, SIENNA, PPV_VOICE_OPTS);
      const tag = v.fixed.match(/^\[[^\]]+\]/)?.[0] ?? "";
      const sentence = await generateVoice(
        `${tag} ${NAME}… ${v.fixed.replace(/^\[[^\]]+\]\s*/, "")}`,
        SIENNA,
        PPV_VOICE_OPTS
      );
      const isolated = await extractNameAudio(sentence, "before");
      const nameAudio = isolated ?? (await generateVoice(`${tag} ${NAME}…`, SIENNA, PPV_VOICE_OPTS));
      const voiceLine = await joinFixedAndName(fixed, nameAudio, "before", CFG.nameGapSec);
      const [fixedSec, lineSec] = [await seconds(fixed), await seconds(voiceLine)];
      // Même calage que le bot : la partie fixe démarre au même instant pour tous
      const start = Math.max(
        0,
        CFG.paid1StartSec + NAME_MAX_SEC + CFG.nameGapSec - (lineSec - fixedSec)
      );
      const ref = (await roomVoice(fixed, CFG.room)).meanDb;
      const out = await mixVoiceIntoVideo(
        videoBuf, voiceLine, { mode: "start", at: start }, targetDbFor(CFG, 2), ref, undefined, CFG.room
      );
      const from = Math.max(0, start - 1);
      await clip(out.video, from, lineSec + 2.4, join(OUT, `${label}.mp4`));
      writeFileSync(join(OUT, `${label}-partie-fixe.mp3`), fixed);
      console.log(
        `${label.padEnd(8)} partie fixe ${fixedSec.toFixed(1)} s · phrase ${lineSec.toFixed(1)} s · prénom ${isolated ? "isolé" : "repli"}`
      );
    }
  }
}

main();
