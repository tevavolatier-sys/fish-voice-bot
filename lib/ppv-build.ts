// Fabrique les vidéos PPV d'un fan SANS passer par Telegram : exactement ce que
// fait « /ppv Prénom » dans le bot (api/webhook.ts), avec les mêmes réglages
// (/ppvsettings), le volume et l'effet par défaut. Utilisé par l'automatisation
// « PPV perso à l'achat du PPV de bienvenue » (lib/ppv-auto.ts).
// Le code du bot n'est pas modifié (demande de Teva, 11/10/2026) : les quelques
// fonctions nécessaires sont reprises ici.
import { modelByKey, type VoiceModel } from "./config.js";
import { generateVoice } from "./fish.js";
import {
  PPV_DEFAULT_MODEL,
  fillLine,
  mixVoiceIntoVideo,
  roomVoice,
  roomVoiceSameLevel,
} from "./ppv.js";
import {
  LEGACY_FIXED_TEXT,
  nameAloneFor,
  normalizeSettings,
  roomFor,
  targetDbFor,
  voiceOpts,
  type PpvSettings,
} from "./ppv-settings.js";
import {
  NAMED_KEYS,
  NAME_MAX_SEC,
  audioSeconds,
  extractNameAudio,
  joinFixedAndName,
  type LineKey,
} from "./ppv-voice.js";
import { getPpvFixed, getPpvParts, getPpvPreview, getPpvSettingsRaw, setPpvFixed } from "./redis.js";
import { blackVideoFromAudio } from "./video.js";

export interface BuiltPpv {
  name: string;
  preview: { video: Buffer; duration: number };
  paid1: { video: Buffer; duration: number };
}

/** Fichier Telegram (vidéos PPV et prises enregistrées sont stockées chez Telegram) */
async function telegramFile(fileId: string): Promise<Buffer> {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN manquant");
  const r = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const j = (await r.json()) as { ok: boolean; result?: { file_path?: string } };
  if (!j.ok || !j.result?.file_path) throw new Error("fichier Telegram introuvable");
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${j.result.file_path}`);
  if (!res.ok) throw new Error(`téléchargement Telegram: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function loadSettings(): Promise<PpvSettings> {
  return normalizeSettings(await getPpvSettingsRaw().catch(() => null));
}

function ppvModel(cfg: PpvSettings): VoiceModel | undefined {
  return modelByKey(cfg.model) ?? modelByKey(PPV_DEFAULT_MODEL);
}

// Partie FIXE : la prise mémorisée (générée ou vrai enregistrement), refaite si le texte a changé
async function fixedAudio(model: VoiceModel, key: LineKey, cfg: PpvSettings): Promise<Buffer> {
  const stored = await getPpvFixed(model.key, key).catch(() => null);
  if (stored?.src === "upload") return telegramFile(stored.f);
  if (stored?.src === "tts" && (stored.t ?? LEGACY_FIXED_TEXT[key]) === cfg.lines[key].fixed) {
    return Buffer.from(stored.a, "base64");
  }
  const text = cfg.lines[key].fixed;
  const audio = await generateVoice(text, model.referenceId, voiceOpts(cfg));
  await setPpvFixed(model.key, key, { src: "tts", a: audio.toString("base64"), at: new Date().toISOString(), t: text });
  return audio;
}

// Une phrase PPV pour un fan : partie fixe + son prénom (pris dans la phrase complète)
async function ppvLine(model: VoiceModel, key: (typeof NAMED_KEYS)[number], fixed: Buffer, name: string, cfg: PpvSettings): Promise<Buffer> {
  const line = cfg.lines[key];
  const pos = line.name === "after" ? "after" : "before";
  const opts = voiceOpts(cfg);
  const sentence = await generateVoice(fillLine(line.context, name), model.referenceId, opts);
  const isolated = await extractNameAudio(sentence, pos).catch(() => null);
  const nameAudio = isolated ?? (await generateVoice(fillLine(nameAloneFor(cfg, key), name), model.referenceId, opts));
  return joinFixedAndName(fixed, nameAudio, pos, cfg.nameGapSec, cfg.nameGainDb);
}

/** Les vidéos PPV sont-elles prêtes (réglages + vidéo PPV 1 chargée par l'admin) ? */
export async function ppvReady(): Promise<{ ok: boolean; why?: string }> {
  const cfg = await loadSettings();
  const model = ppvModel(cfg);
  if (!model) return { ok: false, why: "voix PPV inconnue" };
  const parts = await getPpvParts(model.key).catch(() => []);
  if (parts.length < 1) return { ok: false, why: "vidéo PPV 1 pas chargée dans le bot Telegram" };
  return { ok: true };
}

/** Preview + PPV 1 avec le prénom du fan : même résultat que « /ppv Prénom ». */
export async function buildPpvForFan(name: string): Promise<BuiltPpv> {
  const cfg = await loadSettings();
  const model = ppvModel(cfg);
  if (!model) throw new Error("Voix PPV inconnue (réglages /ppvsettings).");
  const parts = await getPpvParts(model.key).catch(() => []);
  if (parts.length < 1) throw new Error("Vidéo PPV 1 pas chargée dans le bot Telegram.");
  const level = cfg.defaultVolume;
  const effect = cfg.effect;
  const room = roomFor(cfg, effect);

  const fixed = await Promise.all(NAMED_KEYS.map((k) => fixedAudio(model, k, cfg)));
  const [vPreview, vPaid1] = await Promise.all(NAMED_KEYS.map((k, i) => ppvLine(model, k, fixed[i], name, cfg)));

  // ── PPV 1 : la voix posée sur la vidéo, partie fixe au même instant pour tous
  const [line1Sec, fixed1Sec] = await Promise.all([audioSeconds(vPaid1), audioSeconds(fixed[1])]);
  const start1 =
    cfg.lines.paid1.name === "before"
      ? Math.max(0, cfg.paid1StartSec + NAME_MAX_SEC + cfg.nameGapSec - (line1Sec - fixed1Sec))
      : cfg.paid1StartSec;
  const [video1, ref1] = await Promise.all([telegramFile(parts[0].f), roomVoice(fixed[1], room).then((r) => r.meanDb)]);
  const paid1 = await mixVoiceIntoVideo(video1, vPaid1, { mode: "start", at: start1 }, targetDbFor(cfg, level), ref1, undefined, room);

  // ── Preview : vidéo de preview si l'admin en a mis une, sinon fond noir
  const previewPart = await getPpvPreview(model.key).catch(() => null);
  let preview: { video: Buffer; duration: number };
  if (previewPart) {
    const [lineSec, fixedSec, room0] = await Promise.all([audioSeconds(vPreview), audioSeconds(fixed[0]), roomVoice(fixed[0], room)]);
    const start =
      cfg.lines.preview.name === "before"
        ? Math.max(0, cfg.previewStartSec + NAME_MAX_SEC + cfg.nameGapSec - (lineSec - fixedSec))
        : cfg.previewStartSec;
    preview = await mixVoiceIntoVideo(
      await telegramFile(previewPart.f), vPreview, { mode: "start", at: start },
      targetDbFor(cfg, level) + cfg.previewGainDb, room0.meanDb, undefined, room
    );
  } else {
    const voice = cfg.previewEffect ? await roomVoiceSameLevel(vPreview, room) : vPreview;
    preview = await blackVideoFromAudio(voice);
  }
  return { name, preview, paid1 };
}
