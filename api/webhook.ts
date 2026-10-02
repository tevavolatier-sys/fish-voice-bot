import { Bot, Context, InlineKeyboard, InputFile, webhookCallback } from "grammy";
import { waitUntil } from "@vercel/functions";
import { randomUUID } from "node:crypto";
import {
  ACTIVE_MODELS,
  ADMIN_ID,
  MAX_CHARS,
  VoiceModel,
  isAllowed,
  modelByKey,
  modelLabel,
  operatorName,
} from "../lib/config.js";
import {
  getIntensity,
  getLastText,
  getSelectedModel,
  getVideoSource,
  hasRedisEnv,
  lockVideo,
  addPpvPart,
  armPpvGroup,
  clearPpvParts,
  getPpvParts,
  getPpvFixed,
  setPpvFixed,
  getPpvJob,
  getPpvVolume,
  getPpvEffect,
  setPpvEffect,
  getPpvSettingsRaw,
  savePpvSettings,
  saveFixedCandidate,
  getFixedCandidate,
  getPpvPreview,
  setPpvPreview,
  setUploadChunk,
  getUploadChunk,
  deleteUploadChunks,
  lockPpv,
  savePpvJob,
  setPpvVolume,
  ppvGroupModel,
  readPpvStats,
  readStats,
  readVideoStats,
  recordGeneration,
  recordPpv,
  recordVideo,
  resetStats,
  setIntensity,
  setLastText,
  setSelectedModel,
  setVideoSource,
  shouldWarnCredits,
  unlockPpv,
  unlockVideo,
} from "../lib/redis.js";
import {
  LINE_KEYS,
  LINE_LABELS,
  NAMED_KEYS,
  NAME_MAX_SEC,
  audioSeconds,
  extractNameAudio,
  joinFixedAndName,
  type LineKey,
} from "../lib/ppv-voice.js";
import {
  PPV_DEFAULT_MODEL,
  PPV_VOLUME_LEVELS,
  isEffectKey,
  roomVoice,
  roomVoiceSameLevel,
  cleanFanName,
  fillLine,
  mixVoiceIntoVideo,
  type EffectKey,
} from "../lib/ppv.js";
import {
  adjustNum,
  applyPreset,
  fmtNum,
  getNum,
  LEGACY_FIXED_TEXT,
  nameAloneFor,
  normalizeSettings,
  numParam,
  readableLine,
  resetPart,
  roomFor,
  setLineText,
  setNamePos,
  targetDbFor,
  voiceOpts,
  type PpvSettings,
  type ResetPart,
} from "../lib/ppv-settings.js";
import {
  confirmResetKeyboard,
  effectName,
  effectSummary,
  isPanel,
  panelKeyboard,
  panelText,
  ppvControlsKeyboard,
  ppvControlsText,
  type FixedState,
  type Panel,
} from "../lib/ppv-panel.js";
import { VIDEO_HEIGHT, VIDEO_WIDTH, blackVideoFromAudio, videoSelfTest } from "../lib/video.js";
import { FishError, generateVoice, getFishCredits } from "../lib/fish.js";
import {
  DEFAULT_INTENSITY,
  INTENSITY_LEVELS,
  enrichProvider,
  VOICE_STYLES,
  enrichWithEmotionTags,
} from "../lib/enrich.js";

export const maxDuration = 60;

// ---------- Clavier de sélection ----------
function modelKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const m of ACTIVE_MODELS) kb.text(`🎤 ${modelLabel(m)}`, `voice:${m.key}`).row();
  return kb;
}

async function sendModelPicker(ctx: Context, intro: string): Promise<void> {
  await ctx.reply(intro, { reply_markup: modelKeyboard() });
}

// ---------- Clavier d'intensité ----------
// Affiché sous chaque vocal et sous le choix de voix : le niveau actif porte un ✅.
// `base` : clavier déjà commencé (ex. bouton 🎬 Video) auquel on ajoute les niveaux.
function intensityKeyboard(current?: number, base?: InlineKeyboard): InlineKeyboard {
  const kb = base ?? new InlineKeyboard();
  const entries = Object.entries(INTENSITY_LEVELS);
  entries.forEach(([level, cfg], i) => {
    const active = Number(level) === current;
    kb.text(`${active ? "✅ " : ""}${cfg.label}`, `level:${level}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

// ---------- Clavier sous un vocal ----------
// « 🎬 Video » sous CHAQUE version (on transforme la prise qu'on préfère),
// + les niveaux d'intensité sous la dernière seulement.
function voiceKeyboard(videoToken: string, intensity?: number): InlineKeyboard {
  const kb = new InlineKeyboard().text("🎬 Video", `vid:${videoToken}`);
  if (intensity === undefined) return kb;
  return intensityKeyboard(intensity, kb.row());
}

const newVideoToken = () => randomUUID().replace(/-/g, "").slice(0, 16);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 🎙️ PPV : réglages, parties fixes, phrases ----------
// Tout ce qui façonne un PPV vient des réglages (/ppvsettings, admin) : relus
// à chaque PPV, un changement s'applique tout de suite.
async function loadSettings(): Promise<PpvSettings> {
  return normalizeSettings(await getPpvSettingsRaw().catch(() => null));
}

/** Voix des PPV : celle des réglages, sinon celle par défaut. */
function ppvModel(cfg: PpvSettings): VoiceModel | undefined {
  return modelByKey(cfg.model) ?? modelByKey(PPV_DEFAULT_MODEL);
}

// Partie FIXE : générée UNE fois (puis la même pour tous les fans) et refaite
// si son texte a changé — ou un vrai enregistrement de la modèle (/ppvfix),
// gardé tant qu'il n'est pas remplacé.
async function fixedAudio(
  ctx: Context,
  model: VoiceModel,
  key: LineKey,
  cfg: PpvSettings
): Promise<Buffer> {
  const stored = await getPpvFixed(model.key, key).catch(() => null);
  if (stored?.src === "upload") return downloadTelegramFile(ctx, stored.f);
  if (stored?.src === "tts" && (stored.t ?? LEGACY_FIXED_TEXT[key]) === cfg.lines[key].fixed) {
    return Buffer.from(stored.a, "base64");
  }
  return newFixedTake(model, key, cfg);
}

async function newFixedTake(model: VoiceModel, key: LineKey, cfg: PpvSettings): Promise<Buffer> {
  const text = cfg.lines[key].fixed;
  const audio = await generateVoice(text, model.referenceId, voiceOpts(cfg));
  await setPpvFixed(model.key, key, {
    src: "tts",
    a: audio.toString("base64"),
    at: new Date().toISOString(),
    t: text,
  });
  return audio;
}

/** État d'une partie fixe, pour le panneau 🎙️ Takes */
async function fixedStates(cfg: PpvSettings): Promise<FixedState> {
  const model = ppvModel(cfg);
  if (!model) return {};
  const out: FixedState = {};
  await Promise.all(
    LINE_KEYS.map(async (k) => {
      const s = await getPpvFixed(model.key, k).catch(() => null);
      out[k] = !s
        ? "not made yet (made at the next PPV)"
        : s.src === "upload"
          ? "🎤 real recording"
          : (s.t ?? LEGACY_FIXED_TEXT[k]) !== cfg.lines[k].fixed
            ? "text changed → remade at the next PPV"
            : "generated take";
    })
  );
  return out;
}

// Une phrase PPV pour un fan : partie fixe + son prénom. Le prénom est pris
// dans la phrase complète dite par le clone (bonne intonation) ; repli sur
// le prénom généré seul si la pause qui l'isole n'est pas trouvée.
async function ppvLine(
  model: VoiceModel,
  key: (typeof NAMED_KEYS)[number],
  fixed: Buffer,
  name: string,
  cfg: PpvSettings
): Promise<Buffer> {
  const line = cfg.lines[key];
  const pos = line.name === "after" ? "after" : "before";
  const opts = voiceOpts(cfg);
  const sentence = await generateVoice(fillLine(line.context, name), model.referenceId, opts);
  const isolated = await extractNameAudio(sentence, pos).catch(() => null);
  const nameAudio =
    isolated ??
    (await generateVoice(fillLine(nameAloneFor(cfg, key), name), model.referenceId, opts));
  return joinFixedAndName(fixed, nameAudio, pos, cfg.nameGapSec, cfg.nameGainDb);
}

const FIX_ALIASES: Record<string, LineKey> = {
  preview: "preview",
  ppv1: "paid1",
  paid1: "paid1",
  ppv2: "paid2",
  paid2: "paid2",
  vault: "paid2",
};

const takeKeyboard = (key: LineKey) =>
  new InlineKeyboard().text("🔁 New take", `ppvfix:${key}`).text("🎲 3 takes", `ppvcand:${key}`);

/** Effet / volume d'un chatter : son dernier choix, sinon ceux des réglages. */
async function userEffect(userId: number, cfg: PpvSettings): Promise<EffectKey> {
  const e = await getPpvEffect(userId).catch(() => null);
  return isEffectKey(e) ? e : cfg.effect;
}

async function userVolume(userId: number, cfg: PpvSettings): Promise<number> {
  const v = await getPpvVolume(userId).catch(() => null);
  return v && PPV_VOLUME_LEVELS[v] ? v : cfg.defaultVolume;
}

// La vidéo PPV 1, voix posée au volume et avec l'effet demandés. Le gain est
// calé sur la partie fixe passée dans le MÊME effet : elle sonne pareil pour
// tous les fans. (PPV 2 est la même pour tous : faite une fois via 🎬.)
async function sendPaidVideo(
  ctx: Context,
  job: {
    name: string;
    v1: Buffer;
    f1?: Buffer; // partie fixe seule
    p1: string;
    r1?: number; // ancien format (effet iPhone)
    s1?: number; // début de la phrase : sa partie fixe tombe au même instant pour tous
  },
  level: number,
  effect: EffectKey,
  cfg: PpvSettings,
  replyTo?: number
): Promise<void> {
  const room = roomFor(cfg, effect);
  const [video, ref] = await Promise.all([
    downloadTelegramFile(ctx, job.p1),
    job.f1
      ? roomVoice(job.f1, room).then((r) => r.meanDb)
      : Promise.resolve(effect === "iphone" ? job.r1 : undefined),
  ]);
  const out = await mixVoiceIntoVideo(
    video,
    job.v1,
    { mode: "start", at: job.s1 ?? cfg.paid1StartSec },
    targetDbFor(cfg, level),
    ref,
    undefined,
    room
  );
  const slug = job.name.normalize("NFD").replace(/[^\w-]+/g, "").toLowerCase() || "fan";
  await ctx.replyWithVideo(new InputFile(out.video, `ppv1-${slug}.mp4`), {
    ...(out.width && out.height ? { width: out.width, height: out.height } : {}),
    duration: out.duration,
    supports_streaming: true,
    caption: `💰 PPV 1 · ${job.name} · ${PPV_VOLUME_LEVELS[level]?.icon ?? "🔉"} ${level}/5 · ${effectName(effect)}`,
    ...(replyTo
      ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
      : {}),
  });
}

// 🎬 PPV 2 : la MÊME vidéo pour tous les fans (pas de prénom), rendue avec
// l'effet et le volume par défaut des réglages, à mettre une fois dans le vault.
async function makeVault2(ctx: Context, cfg: PpvSettings): Promise<void> {
  try {
    const model = ppvModel(cfg);
    const parts = model ? await getPpvParts(model.key).catch(() => []) : [];
    if (!model || parts.length < 2) {
      await ctx.reply(
        "⚠️ No PPV 2 video saved: send it to me with the caption /ppvadd — it must be the 2nd one in /ppvlist."
      );
      return;
    }
    await ctx.replyWithChatAction("upload_video").catch(() => {});
    const [video, fixed] = await Promise.all([
      downloadTelegramFile(ctx, parts[1].f),
      fixedAudio(ctx, model, "paid2", cfg),
    ]);
    const out = await mixVoiceIntoVideo(
      video,
      fixed,
      { mode: "end", before: Math.max(0, cfg.paid2EndSec - (cfg.room.reverbSec + 0.1)) },
      targetDbFor(cfg, cfg.defaultVolume),
      undefined,
      undefined,
      cfg.room
    );
    await ctx.replyWithVideo(new InputFile(out.video, "ppv2-vault.mp4"), {
      ...(out.width && out.height ? { width: out.width, height: out.height } : {}),
      duration: out.duration,
      supports_streaming: true,
      caption:
        `🎬 PPV 2 — the SAME for every fan (no name): « ${readableLine(cfg.lines.paid2)} »\n` +
        `${effectSummary(cfg)} · volume ${cfg.defaultVolume}/5\n` +
        "Upload it to the vault once. Changed a setting? Tap 🎬 Make PPV 2 again.",
    });
  } catch (err) {
    console.error("PPV 2 échoué:", err);
    await ctx
      .reply(err instanceof FishError ? err.userMessage : "❌ Couldn't make PPV 2 — try again.")
      .catch(() => {});
  }
}

// Lance le PPV d'un fan (commande /ppv ou 🧪 Test du panneau) : vérifie, pose
// le verrou (1 PPV à la fois par opérateur) puis génère en arrière-plan.
async function startPpv(ctx: Context, name: string, replyTo?: number): Promise<void> {
  const cfg = await loadSettings();
  const model = ppvModel(cfg);
  const parts = model ? await getPpvParts(model.key).catch(() => []) : [];
  if (!model || parts.length < 1) {
    await ctx.reply("⚠️ The PPV videos aren't set up yet — tell the admin.");
    return;
  }
  const userId = ctx.from!.id;
  if (!(await lockPpv(userId).catch(() => true))) {
    await ctx.reply("⏳ Your previous PPV is still being made — wait a few seconds.");
    return;
  }
  await ctx.reply(`⏳ Making ${name}'s PPV: free preview + PPV 1 video… (about 20 seconds)`);
  waitUntil(makePpv(ctx, name, userId, cfg, model, parts[0].f, replyTo));
}

async function makePpv(
  ctx: Context,
  name: string,
  userId: number,
  cfg: PpvSettings,
  model: VoiceModel,
  paid1Video: string,
  replyTo?: number
): Promise<void> {
  const reply = replyTo
    ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
    : {};
  const slug = name.normalize("NFD").replace(/[^\w-]+/g, "").toLowerCase() || "fan";
  try {
    await ctx.replyWithChatAction("upload_video").catch(() => {});
    // Parties fixes (identiques pour tous les fans) + le prénom de CE fan
    const fixed = await Promise.all(NAMED_KEYS.map((k) => fixedAudio(ctx, model, k, cfg)));
    const [vPreview, vPaid1] = await Promise.all(
      NAMED_KEYS.map((k, i) => ppvLine(model, k, fixed[i], name, cfg))
    );
    // Prénom AVANT : il finit toujours au même instant, donc la partie fixe
    // démarre au même instant pour tous les fans. Prénom APRÈS : la partie
    // fixe ouvre la phrase, au début réglé.
    const [line1Sec, fixed1Sec] = await Promise.all([
      audioSeconds(vPaid1),
      audioSeconds(fixed[1]),
    ]);
    const start1 =
      cfg.lines.paid1.name === "before"
        ? Math.max(0, cfg.paid1StartSec + NAME_MAX_SEC + cfg.nameGapSec - (line1Sec - fixed1Sec))
        : cfg.paid1StartSec;
    const [level, effect] = await Promise.all([userVolume(userId, cfg), userEffect(userId, cfg)]);
    const previewPart = await getPpvPreview(model.key).catch(() => null);
    let preview: { video: Buffer; duration: number; width?: number; height?: number };
    if (previewPart) {
      // Vidéo de preview : la voix posée dessus, partie fixe à instant constant
      const [lineSec, fixedSec, room0] = await Promise.all([
        audioSeconds(vPreview),
        audioSeconds(fixed[0]),
        roomVoice(fixed[0], roomFor(cfg, effect)),
      ]);
      const start =
        cfg.lines.preview.name === "before"
          ? Math.max(0, cfg.previewStartSec + NAME_MAX_SEC + cfg.nameGapSec - (lineSec - fixedSec))
          : cfg.previewStartSec;
      preview = await mixVoiceIntoVideo(
        await downloadTelegramFile(ctx, previewPart.f),
        vPreview,
        { mode: "start", at: start },
        targetDbFor(cfg, level),
        room0.meanDb,
        undefined,
        roomFor(cfg, effect)
      );
    } else {
      const previewVoice = cfg.previewEffect
        ? await roomVoiceSameLevel(vPreview, roomFor(cfg, effect))
        : vPreview;
      preview = { ...(await blackVideoFromAudio(previewVoice)), width: VIDEO_WIDTH, height: VIDEO_HEIGHT };
    }
    await ctx.replyWithVideo(new InputFile(preview.video, `preview-${slug}.mp4`), {
      ...(preview.width && preview.height ? { width: preview.width, height: preview.height } : {}),
      duration: preview.duration,
      supports_streaming: true,
      caption: `🎁 FREE preview · ${name}`,
      ...reply,
    });
    const job = { name, v1: vPaid1, f1: fixed[1], p1: paid1Video, s1: start1 };
    await sendPaidVideo(ctx, job, level, effect, cfg, replyTo);
    // Gardé 6 h : les boutons refont la vidéo avec la même voix
    const token = newVideoToken();
    await savePpvJob(token, {
      name,
      v1: vPaid1.toString("base64"),
      f1: fixed[1].toString("base64"),
      p1: paid1Video,
      s1: start1,
      lvl: level,
      fx: effect,
    }).catch((err) => console.error("PPV non mémorisé:", err));
    // Libéré AVANT les boutons : un clic immédiat doit marcher
    await unlockPpv(userId).catch(() => {});
    await ctx.reply(ppvControlsText(level, effect), {
      reply_markup: ppvControlsKeyboard(token, level, effect),
    });
    await recordPpv(userId, model.key).catch(() => {});
  } catch (err) {
    console.error("PPV échoué:", err);
    const msg =
      err instanceof FishError
        ? err.userMessage
        : "❌ Couldn't make the PPV. Try /ppv again; if it keeps failing, tell the admin.";
    await ctx.reply(msg).catch(() => {});
  } finally {
    await unlockPpv(userId).catch(() => {});
  }
}

// 🔊 / 🎚️ Refaire la vidéo PPV 1 (même voix, aucun appel à Fish) avec un
// autre volume ou un autre effet ; le choix est retenu pour le chatter.
async function remakePpv(
  ctx: Context,
  token: string,
  change: { level?: number; effect?: EffectKey }
): Promise<void> {
  const userId = ctx.from!.id;
  const job = await getPpvJob(token).catch(() => null);
  if (!job) {
    await ctx.answerCallbackQuery({ text: "Too old — run /ppv again." });
    return;
  }
  if (!(await lockPpv(userId).catch(() => true))) {
    await ctx.answerCallbackQuery({ text: "⏳ Still working on the previous one…" });
    return;
  }
  const cfg = await loadSettings();
  const level =
    change.level ??
    (job.lvl && PPV_VOLUME_LEVELS[job.lvl] ? job.lvl : await userVolume(userId, cfg));
  const effect =
    change.effect ??
    (isEffectKey(job.fx) ? job.fx : job.r1 !== undefined ? "iphone" : await userEffect(userId, cfg));
  if (change.level) await setPpvVolume(userId, level).catch(() => {});
  if (change.effect) await setPpvEffect(userId, effect).catch(() => {});
  await ctx.answerCallbackQuery({ text: `Remaking: volume ${level}/5 · ${effectName(effect)}…` });
  await ctx
    .editMessageText(ppvControlsText(level, effect), {
      reply_markup: ppvControlsKeyboard(token, level, effect),
    })
    .catch(() => {});
  const replyTo = ctx.callbackQuery?.message?.message_id;
  waitUntil(
    (async () => {
      try {
        await ctx.replyWithChatAction("upload_video").catch(() => {});
        await sendPaidVideo(
          ctx,
          {
            name: job.name,
            v1: Buffer.from(job.v1, "base64"),
            f1: job.f1 ? Buffer.from(job.f1, "base64") : undefined,
            p1: job.p1,
            r1: job.r1,
            s1: job.s1,
          },
          level,
          effect,
          cfg,
          replyTo
        );
        await savePpvJob(token, { ...job, lvl: level, fx: effect }).catch(() => {});
        await unlockPpv(userId).catch(() => {});
      } catch (err) {
        console.error("PPV (refonte) échoué:", err);
        await ctx.reply("❌ Couldn't remake the video. Tap the button again.").catch(() => {});
      } finally {
        await unlockPpv(userId).catch(() => {});
      }
    })()
  );
}

// Télécharge un fichier déjà connu de Telegram (≤ 20 Mo pour un bot)
async function downloadTelegramFile(ctx: Context, fileId: string): Promise<Buffer> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("file_path absent");
  const res = await fetch(
    `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`
  );
  if (!res.ok) throw new Error(`téléchargement Telegram: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- Découpage des textes longs ----------
// Un texte > MAX_CHARS est découpé en morceaux ≤ MAX_CHARS aux fins de
// phrases → plusieurs voice notes numérotées au lieu d'un refus sec.
const MAX_PARTS = 3;

function splitLongText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?\n…]+[.!?\n…]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    let s = sentence;
    // Phrase unique plus longue que la limite : coupe dure (cas très rare)
    while (s.length > max) {
      if (current.trim() !== "") chunks.push(current.trim());
      current = "";
      chunks.push(s.slice(0, max).trim());
      s = s.slice(max);
    }
    if ((current + s).length > max && current.trim() !== "") {
      chunks.push(current.trim());
      current = "";
    }
    current += s;
  }
  if (current.trim() !== "") chunks.push(current.trim());
  return chunks;
}

// ---------- Génération TTS (exécutée après la réponse 200 via waitUntil) ----------
async function generateAndReply(
  ctx: Context,
  model: VoiceModel,
  text: string,
  messageId: number,
  userId: number,
  intensity: number,
  partLabel?: string
): Promise<void> {
  try {
    await ctx.replyWithChatAction("record_voice").catch(() => {});
    // Le texte est lu TEL QUEL (la traduction auto EN→FR a été retirée :
    // pour une voix 🇫🇷, écrire directement en français).
    const spoken = text;
    // ── 3 VERSIONS du même vocal, 3 interprétations (🌙 Soft / ✨ Playful /
    // 🔥 Intense) : même texte, tags/intonation différents, synthèses en
    // parallèle. L'opérateur garde celle qui colle le mieux au fan.
    // Si un style échoue, les autres partent quand même.
    const variants = await Promise.all(
      VOICE_STYLES.map(async (style) => {
        try {
          const finalText = await enrichWithEmotionTags(spoken, intensity, true, style.key);
          const audio = await generateVoice(finalText, model.referenceId);
          return { style, finalText, audio };
        } catch (err) {
          console.error(`Variante ${style.key} échouée:`, err);
          return null;
        }
      })
    );
    const ok = variants.filter((v): v is NonNullable<typeof v> => v !== null);
    if (ok.length === 0) {
      // Aucune variante : on remonte la dernière erreur Fish pour le message utilisateur
      throw new FishError(
        "❌ All 3 versions failed to generate. Try again; if it keeps happening, tell the admin.",
        "3 variantes KO"
      );
    }
    for (let i = 0; i < ok.length; i++) {
      const { style, finalText, audio } = ok[i];
      // Légende : voix (+ drapeau, + n° de partie), style, texte FRANÇAIS
      // réellement dit si traduit, et les tags (limite Telegram : 1024)
      const caption = [
        `🎤 ${modelLabel(model)}${partLabel ? ` · part ${partLabel}` : ""} · ${style.label} (${i + 1}/${ok.length})`,
        i === 0 && spoken !== text ? `🇫🇷 ${spoken}` : null,
        finalText !== spoken ? `🎭 ${finalText}` : null,
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 1024);
      // 🎬 sous chaque version ; niveaux d'intensité sous la DERNIÈRE seulement
      const videoToken = newVideoToken();
      const sent = await ctx.replyWithVoice(new InputFile(audio, `voice-${style.key}.mp3`), {
        reply_parameters: {
          message_id: messageId,
          allow_sending_without_reply: true,
        },
        caption,
        reply_markup: voiceKeyboard(videoToken, i === ok.length - 1 ? intensity : undefined),
      });
      // Le bouton 🎬 retrouvera CE vocal (file_id) pour en faire la vidéo
      const fileId = sent.voice?.file_id;
      if (fileId) {
        await setVideoSource(videoToken, { f: fileId, m: model.key, s: style.label }).catch(
          (err) => console.error("Source vidéo non enregistrée:", err)
        );
      }
    }
    await recordGeneration(userId, model.key, text.length * ok.length);

    // Surveillance des crédits (le modèle s1 est payant) : sous le seuil,
    // alerte à l'admin — au plus une fois par 24 h.
    try {
      const credits = await getFishCredits();
      const threshold = Number(process.env.FISH_CREDIT_ALERT ?? 2);
      if (
        credits !== null &&
        credits < threshold &&
        (await shouldWarnCredits())
      ) {
        await ctx.api.sendMessage(
          ADMIN_ID,
          `⚠️ Fish Audio credits low: $${credits.toFixed(2)} left. Top up on fish.audio (API billing) or voice notes will stop.`
        );
      }
    } catch {
      // la surveillance n'est jamais bloquante
    }
  } catch (err) {
    console.error("Erreur de génération TTS:", err);
    const msg =
      err instanceof FishError
        ? err.userMessage
        : "❌ Unexpected error during generation. Try again; if it keeps happening, tell the admin.";
    await ctx
      .reply(msg, {
        reply_markup: new InlineKeyboard().text("🔁 Try again", "retry"),
      })
      .catch(() => {});
  }
}

// ---------- Construction du bot (paresseuse : rien ne s'exécute à l'import) ----------
function createBot(): Bot {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("Variable BOT_TOKEN manquante");

  const bot = new Bot(token);

  // Whitelist stricte : on ignore silencieusement les inconnus
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id || !isAllowed(id, ctx.chat?.id)) return;
    await next();
  });

  // Groupes en mode "Topics" (forum) : les réponses doivent partir dans le
  // même sujet que le message d'origine, sinon elles atterrissent dans General.
  bot.use(async (ctx, next) => {
    const msg = ctx.msg ?? ctx.callbackQuery?.message;
    const threadId = msg?.is_topic_message ? msg.message_thread_id : undefined;
    if (threadId) {
      ctx.api.config.use(async (prev, method, payload, signal) => {
        if (method.startsWith("send") && !("message_thread_id" in payload)) {
          (payload as Record<string, unknown>).message_thread_id = threadId;
        }
        return prev(method, payload, signal);
      });
    }
    await next();
  });

  bot.command(["start", "voice", "voix"], async (ctx) => {
    await sendModelPicker(
      ctx,
      "🎙️ STEP 1 of 3\n\n" +
        "👇 Tap the girl whose voice you want:"
    );
  });

  bot.command(["level", "niveau"], async (ctx) => {
    const current =
      (await getIntensity(ctx.from!.id).catch(() => null)) ?? DEFAULT_INTENSITY;
    const label =
      INTENSITY_LEVELS[current]?.label ??
      INTENSITY_LEVELS[DEFAULT_INTENSITY].label;
    await ctx.reply(
      "🌡️ VOICE INTENSITY\n\n" +
        `Current level: ${label}\n\n` +
        "😇 Normal = no sexualization at all.\n" +
        "The hotter the level, the more breathing, moaning and sensual pauses.\n\n" +
        "👇 Pick a level:",
      { reply_markup: intensityKeyboard(current) }
    );
  });

  bot.command(["help", "aide"], async (ctx) => {
    await ctx.reply(
      "📖 TUTORIAL — HOW TO MAKE A VOICE NOTE\n\n" +
        "1️⃣ Type /voice\n" +
        "2️⃣ Tap the girl\n" +
        "3️⃣ Write your message as if SHE was the one talking — in the language of the voice\n" +
        "   🇫🇷 = French voice → write in FRENCH\n" +
        "   🇺🇸 = English voice → write in ENGLISH\n" +
        "4️⃣ Send the message\n" +
        "5️⃣ Wait a few seconds\n" +
        "6️⃣ You receive 3 VERSIONS of the voice note 🎤 — same words, 3 readings: 🌙 Soft · ✨ Playful · 🔥 Intense → pick the one that fits the fan and send it\n" +
        "🎬 Fan wants a VIDEO (\"a video with my name\")? Tap 🎬 Video under the version you like: you get the same voice as a black-screen video, ready to send.\n" +
        "💰 PPV with his name: type /ppv + his first name (ex: /ppv Julien) → a FREE preview + the PPV 1 video with his name in it (buttons under it: volume + voice effect).\n\n" +
        "✅ DO THIS:\n" +
        "• Short sentences, like a real voice note\n" +
        "• Write normally, emotions are added AUTOMATICALLY ✨\n\n" +
        "🌡️ INTENSITY: use the buttons under each voice note (or /level):\n" +
        "😇 Normal (no sexualization) → 🌶️ Light → 🌶️🌶️ Hot → 🌶️🌶️🌶️ Very hot\n" +
        "The hotter, the more breathing, moaning and pauses.\n\n" +
        "❌ DON'T DO THIS:\n" +
        `• A text longer than ${MAX_CHARS * 3} characters (the bot will refuse)\n` +
        `• Between ${MAX_CHARS} and ${MAX_CHARS * 3} characters: the bot splits it into several voice notes automatically 📚\n` +
        "• Writing like a robot (\"Hello. How are you.\")\n\n" +
        "————————————\n" +
        "🎭 PRO MODE (optional!)\n" +
        "You can place tags [like this] in your text yourself.\n" +
        "If you do, the bot adds nothing and keeps your tags as-is.\n\n" +
        "😊 Positive emotions:\n" +
        "[excited] [delighted] [joyful] [satisfied] [proud] [confident]\n" +
        "[relaxed] [grateful] [moved] [amused] [curious] [interested]\n\n" +
        "😢 Negative emotions:\n" +
        "[sad] [unhappy] [upset] [depressed] [worried] [anxious]\n" +
        "[nervous] [scared] [panicked] [angry] [furious] [frustrated]\n" +
        "[impatient] [guilty] [embarrassed] [awkward] [hesitating]\n\n" +
        "😲 Other emotions:\n" +
        "[surprised] [astonished] [confused] [serious] [sincere]\n" +
        "[comforting] [empathetic] [sarcastic]\n\n" +
        "🗣️ Speaking styles:\n" +
        "[whispering] [soft tone] [shouting] [screaming] [in a hurry tone]\n\n" +
        "🔊 Sounds and breathing:\n" +
        "[laughing] [chuckling] [giggling] [sobbing] [crying loudly]\n" +
        "[sighing] [breath] [panting] [groaning] [cough] [lip-smacking]\n\n" +
        "⏸️ Pauses:\n" +
        "[break] [long-break]\n\n" +
        "Example:\n" +
        "[whispering] Hey you... [break] [excited] I have a surprise for you!"
    );
  });

  // 💳 Solde de crédits Fish Audio (admin) — le modèle s1 est payant
  bot.command(["credits", "credit"], async (ctx) => {
    if (ctx.from?.id !== ADMIN_ID) return; // réservé admin, silencieux
    const credits = await getFishCredits();
    await ctx.reply(
      credits === null
        ? "❌ Couldn't fetch the Fish Audio balance — try again in a minute."
        : `💳 Fish Audio credits: $${credits.toFixed(2)}\n(An automatic alert fires below $${Number(process.env.FISH_CREDIT_ALERT ?? 2)}.)`
    );
  });

  bot.command("stats", async (ctx) => {
    if (ctx.from?.id !== ADMIN_ID) return; // réservé admin, silencieux pour les autres

    if (ctx.match?.trim().toLowerCase() === "reset") {
      await resetStats();
      await ctx.reply("🧹 Stats reset to zero.");
      return;
    }

    const empty = { byModel: {}, byUser: {} } as Awaited<ReturnType<typeof readVideoStats>>;
    const [stats, videos, ppvs] = await Promise.all([
      readStats(),
      readVideoStats().catch(() => empty),
      readPpvStats().catch(() => empty),
    ]);
    const vidSuffix = (n: number, p = 0) =>
      (n > 0 ? `, 🎬 ${n} video${n > 1 ? "s" : ""}` : "") + (p > 0 ? `, 💰 ${p} PPV` : "");

    const modelLines = ACTIVE_MODELS.map((m) => {
      const gen = Number(stats.genByModel[m.key] ?? 0);
      const chars = Number(stats.charsByModel[m.key] ?? 0);
      return `• ${modelLabel(m)}: ${gen} voice notes, ${chars} characters${vidSuffix(Number(videos.byModel[m.key] ?? 0), Number(ppvs.byModel[m.key] ?? 0))}`;
    }).join("\n");

    const userIds = new Set([
      ...Object.keys(stats.genByUser),
      ...Object.keys(stats.charsByUser),
    ]);
    const userLines =
      [...userIds]
        .map((id) => {
          const gen = Number(stats.genByUser[id] ?? 0);
          const chars = Number(stats.charsByUser[id] ?? 0);
          return `• ${operatorName(id)}: ${gen} voice notes, ${chars} characters${vidSuffix(Number(videos.byUser[id] ?? 0), Number(ppvs.byUser[id] ?? 0))}`;
        })
        .join("\n") || "• No voice notes yet";

    await ctx.reply(
      "📊 Stats (all-time)\n\n" +
        "By model:\n" +
        modelLines +
        "\n\nBy operator:\n" +
        userLines +
        "\n\n(/stats reset to reset counters)"
    );
  });

  // Sélection du niveau d'intensité via bouton
  bot.callbackQuery(/^level:(\d)$/, async (ctx) => {
    const level = Number(ctx.match[1]);
    const cfg = INTENSITY_LEVELS[level];
    if (!cfg) {
      await ctx.answerCallbackQuery({ text: "Unknown level." });
      return;
    }
    await setIntensity(ctx.from.id, level);
    await ctx.answerCallbackQuery({
      text: `${cfg.label} — applies to your next voice notes`,
    });
    // Le clavier peut être sous un message texte OU sous un vocal :
    // on met juste à jour les boutons (déplacement du ✅), en GARDANT le
    // bouton 🎬 Video s'il y en a un (sous le dernier vocal).
    const videoData = (ctx.callbackQuery.message?.reply_markup?.inline_keyboard ?? [])
      .flat()
      .map((b) => ("callback_data" in b ? b.callback_data : undefined))
      .find((d): d is string => typeof d === "string" && d.startsWith("vid:"));
    await ctx
      .editMessageReplyMarkup({
        reply_markup: videoData
          ? voiceKeyboard(videoData.slice(4), level)
          : intensityKeyboard(level),
      })
      .catch(() => {});
  });

  // Sélection d'une modèle via bouton
  bot.callbackQuery(/^voice:(.+)$/, async (ctx) => {
    const model = modelByKey(ctx.match[1]);
    if (!model) {
      await ctx.answerCallbackQuery({ text: "Unknown voice." });
      return;
    }
    await setSelectedModel(ctx.from.id, model.key);
    await ctx.answerCallbackQuery({ text: `Voice selected: ${modelLabel(model)}` });
    const currentLevel =
      (await getIntensity(ctx.from.id).catch(() => null)) ?? DEFAULT_INTENSITY;
    await ctx
      .editMessageText(
        `✅ Voice selected: ${modelLabel(model)}\n\n` +
          (model.lang === "fr"
            ? "🇫🇷 She speaks FRENCH: write your message IN FRENCH, it's spoken as-is.\n\n"
            : "🇺🇸 She speaks ENGLISH: write your message in English, it's spoken as-is.\n\n") +
          "📝 STEP 2 of 3: write your message\n" +
          "• Write as if SHE was the one talking\n" +
          "• Short, natural sentences\n" +
          "• Write normally: emotions are added AUTOMATICALLY ✨\n\n" +
          "Example:\n" +
          "Hey you, I missed you today...\n\n" +
          "📤 STEP 3 of 3: send your message, wait a few seconds, and you get the voice note 🎤\n\n" +
          "🌡️ Intensity of the voice — tap to change:",
        { reply_markup: intensityKeyboard(currentLevel) }
      )
      .catch(() => {});
  });

  // ---------- 💰 PPV personnalisé : /ppv <prénom> ----------
  // 2 fichiers avec la voix de la modèle : preview gratuite fond noir + la
  // vidéo PPV 1 enregistrée, avec le prénom. (PPV 2 : fixe, dans le vault.)
  bot.command("ppv", async (ctx) => {
    const name = cleanFanName(String(ctx.match ?? ""));
    if (!name) {
      await ctx.reply(
        "💰 PERSONALIZED PPV\n\n" +
          "Type /ppv followed by the fan's first name, like:\n" +
          "/ppv Julien\n\n" +
          "You get 2 files with the girl's voice saying his name:\n" +
          "🎁 a FREE preview video: \"Julien… n'oublie pas, il faut tenir jusqu'au bout…\"\n" +
          "💰 the PPV 1 video: \"Julien… hmm, c'est chaud\"\n" +
          "Under it: buttons to change the volume and the voice effect.\n" +
          "(PPV 2 is the same for every fan: it's already in the vault.)\n\n" +
          "(First name only: letters, 2 to 20 characters.)"
      );
      return;
    }
    await startPpv(ctx, name, ctx.msg?.message_id);
  });

  // 🔊 / 🎚️ Refaire la vidéo PPV 1 à un autre volume ou avec un autre effet
  bot.callbackQuery(/^ppvvol:([a-z0-9]{6,32}):([1-5])$/, (ctx) =>
    remakePpv(ctx, ctx.match[1], { level: Number(ctx.match[2]) })
  );
  bot.callbackQuery(/^ppvfx:([a-z0-9]{6,32}):([a-z]+)$/, async (ctx) => {
    const effect = ctx.match[2];
    if (!isEffectKey(effect)) {
      await ctx.answerCallbackQuery({ text: "Unknown effect." });
      return;
    }
    await remakePpv(ctx, ctx.match[1], { effect });
  });

  // ---------- ⚙️ Réglages PPV (admin) ----------
  const openSettings = async (ctx: Context) => {
    if (ctx.from?.id !== ADMIN_ID) return;
    const cfg = await loadSettings();
    await ctx.reply(panelText(cfg, "main"), { reply_markup: panelKeyboard(cfg, "main") });
  };
  bot.command(["ppvsettings", "reglages", "settings"], openSettings);

  bot.callbackQuery(/^cfg:(.+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
      await ctx.answerCallbackQuery({ text: "Admin only." });
      return;
    }
    const [action, a1, a2] = ctx.match[1].split(":");
    let cfg = await loadSettings();
    let panel: Panel = "main";
    let changed = false;
    let note: string | undefined;

    switch (action) {
      case "p":
        panel = isPanel(a1) ? a1 : "main";
        break;
      case "fx":
        panel = "effect";
        if (isEffectKey(a1)) {
          cfg = applyPreset(cfg, a1);
          changed = true;
          note = `Effect: ${effectName(a1)}`;
        }
        break;
      case "a": {
        const p = numParam(a1);
        if (p) {
          cfg = adjustNum(cfg, p.key, a2 === "u" ? 1 : -1);
          changed = true;
          panel = p.section;
          note = `${p.label}: ${fmtNum(p, getNum(cfg, p.key))}`;
        }
        break;
      }
      case "i": {
        const p = numParam(a1);
        await ctx.answerCallbackQuery({
          text: p
            ? `${p.label} (${fmtNum(p, p.min)} → ${fmtNum(p, p.max)})\n${p.help}`
            : "BEFORE: « Julien… c'est chaud. » · AFTER: « c'est chaud… Julien. »",
          show_alert: true,
        });
        return;
      }
      case "pv":
        cfg = { ...cfg, previewEffect: !cfg.previewEffect };
        changed = true;
        panel = "effect";
        note = `Effect on the preview: ${cfg.previewEffect ? "on" : "off"}`;
        break;
      case "md":
        panel = "voice";
        if (modelByKey(a1)) {
          cfg = { ...cfg, model: a1 };
          changed = true;
          note = `Voice: ${modelLabel(modelByKey(a1)!)}`;
        }
        break;
      case "np":
        panel = "timing";
        if ((NAMED_KEYS as readonly string[]).includes(a1)) {
          cfg = setNamePos(cfg, a1 as LineKey, a2 === "a" ? "after" : "before");
          changed = true;
          note = `${LINE_LABELS[a1 as LineKey]}: name ${a2 === "a" ? "AFTER" : "BEFORE"}`;
        }
        break;
      case "rs":
        if (["effect", "volume", "voice", "timing", "texts"].includes(a1)) {
          cfg = resetPart(cfg, a1 as ResetPart);
          changed = true;
          panel = a1 as Panel;
          note = `${a1} reset`;
        }
        break;
      case "rall":
        await ctx.answerCallbackQuery();
        await ctx
          .editMessageText(
            panelText(cfg, "main") + "\n\n⚠️ Reset EVERY setting to its default?",
            { reply_markup: confirmResetKeyboard() }
          )
          .catch(() => {});
        return;
      case "rall!":
        cfg = resetPart(cfg, "all");
        changed = true;
        note = "Everything reset";
        break;
      case "test":
        await ctx.answerCallbackQuery({ text: "🧪 /ppv Julien…" });
        await startPpv(ctx, "Julien");
        return;
      case "v2":
        await ctx.answerCallbackQuery({ text: "🎬 Making PPV 2…" });
        waitUntil(makeVault2(ctx, cfg));
        return;
    }
    if (changed) await savePpvSettings(cfg);
    await ctx.answerCallbackQuery(note ? { text: `✅ ${note}` } : {}).catch(() => {});
    const states = panel === "takes" ? await fixedStates(cfg) : {};
    await ctx
      .editMessageText(panelText(cfg, panel, states), { reply_markup: panelKeyboard(cfg, panel) })
      .catch(() => {});
  });

  // ✍️ Admin : nouveau texte de partie fixe (/ppvtext ppv1 Hmm, c'est chaud…)
  bot.command("ppvtext", async (ctx) => {
    if (ctx.from?.id !== ADMIN_ID) return;
    const m = String(ctx.match ?? "").trim().match(/^(\w+)\s+([\s\S]+)$/);
    const key = m ? FIX_ALIASES[m[1].toLowerCase()] : undefined;
    if (!m || !key) {
      await ctx.reply(
        "✍️ Send: /ppvtext preview|ppv1|ppv2 <new text>\n" +
          "Example: /ppvtext ppv1 [soft tone] Hmm, c'est chaud.\n" +
          "Don't write the name: it's added automatically (before/after: ⚙️ /ppvsettings → ⏱️ Timing)."
      );
      return;
    }
    const cfg = await loadSettings();
    const next = setLineText(cfg, key, m[2]);
    if (!next) {
      await ctx.reply("❌ Text not usable: 2 to 200 characters, with words.");
      return;
    }
    await savePpvSettings(next);
    const model = ppvModel(next);
    const stored = model ? await getPpvFixed(model.key, key).catch(() => null) : null;
    const line = next.lines[key];
    await ctx.reply(
      `✅ ${LINE_LABELS[key]}: « ${readableLine(line)} »\n` +
        (line.name === "none" ? "" : `Said as: ${line.context}\n`) +
        (stored?.src === "upload"
          ? "⚠️ A REAL recording is used for this line: it stays until you send a new one (/ppvfix) or tap 🔁 New take."
          : "The fixed part is remade with this text at the next PPV — or pick it now with 🎲 3 takes."),
      { reply_markup: takeKeyboard(key) }
    );
  });

  // 🎙️ Admin : écouter / refaire les parties fixes des 3 phrases
  bot.command("ppvfixed", async (ctx) => {
    if (ctx.from?.id !== ADMIN_ID) return;
    await ctx.reply(
      "🎙️ FIXED PARTS — the same for every fan, only the name changes.\n" +
        "🔁 New take replaces it now · 🎲 3 takes lets you pick. To use a REAL recording of the girl instead, send it to me as a voice/audio with the caption /ppvfix preview, /ppvfix ppv1 or /ppvfix ppv2."
    );
    // Génération possible (1re fois) : en arrière-plan, sinon Telegram
    // renvoie la commande au bout de 10 s.
    waitUntil(
      (async () => {
        const cfg = await loadSettings();
        const model = ppvModel(cfg);
        if (!model) return;
        for (const key of LINE_KEYS) await sendFixedPart(ctx, model, key, cfg);
      })().catch(async (err) => {
        console.error("/ppvfixed échoué:", err);
        await ctx.reply("❌ Couldn't load the fixed parts — try again.").catch(() => {});
      })
    );
  });

  const sendFixedPart = async (ctx: Context, model: VoiceModel, key: LineKey, cfg: PpvSettings) => {
    const stored = await getPpvFixed(model.key, key).catch(() => null);
    const audio = await fixedAudio(ctx, model, key, cfg);
    await ctx.replyWithAudio(new InputFile(audio, `fixe-${key}.mp3`), {
      caption: `${LINE_LABELS[key]} · ${stored?.src === "upload" ? "real recording" : "generated take"}\n« ${readableLine(cfg.lines[key])} »`,
      reply_markup: takeKeyboard(key),
    });
  };

  const adminOnly = async (ctx: Context): Promise<boolean> => {
    if (ctx.from?.id === ADMIN_ID) return true;
    await ctx.answerCallbackQuery({ text: "Admin only." }).catch(() => {});
    return false;
  };

  bot.callbackQuery(/^ppvhear:(preview|paid1|paid2)$/, async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const key = ctx.match[1] as LineKey;
    await ctx.answerCallbackQuery({ text: "🔊 …" });
    waitUntil(
      (async () => {
        const cfg = await loadSettings();
        const model = ppvModel(cfg);
        if (model) await sendFixedPart(ctx, model, key, cfg);
      })().catch(async (err) => {
        console.error("Écoute échouée:", err);
        await ctx.reply("❌ Couldn't load this fixed part — try again.").catch(() => {});
      })
    );
  });

  bot.callbackQuery(/^ppvfix:(preview|paid1|paid2)$/, async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const key = ctx.match[1] as LineKey;
    await ctx.answerCallbackQuery({ text: "🔁 New take…" });
    waitUntil(
      (async () => {
        try {
          const cfg = await loadSettings();
          const model = ppvModel(cfg);
          if (!model) return;
          const audio = await newFixedTake(model, key, cfg);
          await ctx.replyWithAudio(new InputFile(audio, `fixe-${key}.mp3`), {
            caption: `${LINE_LABELS[key]} · NEW generated take — now used for every fan`,
            reply_markup: takeKeyboard(key),
          });
        } catch (err) {
          console.error("Nouvelle prise échouée:", err);
          await ctx.reply("❌ Couldn't make a new take — try again.").catch(() => {});
        }
      })()
    );
  });

  // 🎲 3 prises au choix : rien ne change tant qu'on n'a pas tapé ✅
  bot.callbackQuery(/^ppvcand:(preview|paid1|paid2)$/, async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const key = ctx.match[1] as LineKey;
    await ctx.answerCallbackQuery({ text: "🎲 Making 3 takes…" });
    waitUntil(
      (async () => {
        try {
          const cfg = await loadSettings();
          const model = ppvModel(cfg);
          if (!model) return;
          const text = cfg.lines[key].fixed;
          // Une à la fois : Fish limite les requêtes simultanées
          for (let i = 1; i <= 3; i++) {
            const audio = await generateVoice(text, model.referenceId, voiceOpts(cfg));
            const id = newVideoToken();
            await saveFixedCandidate(id, { line: key, model: model.key, a: audio.toString("base64"), t: text });
            await ctx.replyWithAudio(new InputFile(audio, `prise-${key}-${i}.mp3`), {
              caption: `🎲 ${LINE_LABELS[key]} · take ${i}/3\n« ${readableLine(cfg.lines[key])} »`,
              reply_markup: new InlineKeyboard().text("✅ Use this one", `ppvuse:${id}`),
            });
          }
        } catch (err) {
          console.error("Prises échouées:", err);
          await ctx
            .reply(err instanceof FishError ? err.userMessage : "❌ Couldn't make the takes — try again.")
            .catch(() => {});
        }
      })()
    );
  });

  bot.callbackQuery(/^ppvuse:([a-z0-9]{6,32})$/, async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const c = await getFixedCandidate(ctx.match[1]).catch(() => null);
    const key = c ? FIX_ALIASES[c.line] : undefined;
    if (!c || !key) {
      await ctx.answerCallbackQuery({ text: "Too old — tap 🎲 3 takes again." });
      return;
    }
    const cfg = await loadSettings();
    if (c.t !== cfg.lines[key].fixed) {
      await ctx.answerCallbackQuery({
        text: "The text changed since this take: tap 🎲 3 takes again.",
        show_alert: true,
      });
      return;
    }
    await setPpvFixed(c.model, key, { src: "tts", a: c.a, at: new Date().toISOString(), t: c.t });
    await ctx.answerCallbackQuery({ text: "✅ Now used for every fan" });
    await ctx.reply(
      `✅ ${LINE_LABELS[key]}: this take is now the fixed part for every fan.` +
        (key === "paid2" ? "\n🎬 Make PPV 2 again (⚙️ /ppvsettings) to get the new vault video." : "")
    );
  });

  // Admin : vrai enregistrement de la modèle comme partie fixe
  bot.on(["message:voice", "message:audio"], async (ctx, next) => {
    if (ctx.from?.id !== ADMIN_ID) return next();
    const m = (ctx.message.caption ?? "").trim().match(/^\/ppvfix(?:@\w+)?\s+(\w+)/i);
    if (!m) return next();
    const key = FIX_ALIASES[m[1].toLowerCase()];
    const cfg = await loadSettings();
    const model = ppvModel(cfg);
    if (!key || !model) {
      await ctx.reply("❌ Use /ppvfix preview, /ppvfix ppv1 or /ppvfix ppv2 as the caption.");
      return;
    }
    const file = ctx.message.voice ?? ctx.message.audio;
    if (!file) return next();
    await setPpvFixed(model.key, key, {
      src: "upload",
      f: file.file_id,
      kind: ctx.message.voice ? "voice" : "audio",
      at: new Date().toISOString(),
      t: cfg.lines[key].fixed,
    });
    const line = cfg.lines[key];
    await ctx.reply(
      `✅ ${LINE_LABELS[key]}: this real recording is now the fixed part for every fan.\n` +
        `Say it like this: « ${line.fixed.replace(/\[[^\]]*\]\s*/g, "")} »` +
        (line.name === "before"
          ? " (the name is added BEFORE)"
          : line.name === "after"
            ? " (the name is added AFTER)"
            : "")
    );
  });

  // 🗂️ Admin : vidéos PPV enregistrées / remise à zéro
  bot.command("ppvlist", async (ctx) => {
    if (ctx.from?.id !== ADMIN_ID) return;
    const cfg = await loadSettings();
    const model = ppvModel(cfg);
    const parts = model ? await getPpvParts(model.key).catch(() => []) : [];
    await ctx.reply(
      parts.length === 0
        ? "🗂️ No PPV video saved yet.\nSend me the videos in private with the caption /ppvadd, IN ORDER: first PPV 1 (gets the fan's name), then PPV 2 (the same for every fan)."
        : `🗂️ PPV videos for ${model ? modelLabel(model) : cfg.model}: ${parts.length}\n` +
            parts
              .map(
                (p, i) =>
                  `${i + 1}. ${Math.round(p.d)} s · ${(p.b / 1_048_576).toFixed(1)} MB` +
                  (i === 0
                    ? ` → PPV 1 (« ${readableLine(cfg.lines.paid1)} »)`
                    : i === 1
                      ? " → PPV 2 (the same for every fan: ⚙️ /ppvsettings → 🎬 Make PPV 2)"
                      : " → not used")
              )
              .join("\n") +
            "\n\n/ppvclear to remove them all · ⚙️ /ppvsettings for every setting."
    );
  });

  bot.command("ppvclear", async (ctx) => {
    if (ctx.from?.id !== ADMIN_ID) return;
    await clearPpvParts(ppvModel(await loadSettings())?.key ?? PPV_DEFAULT_MODEL);
    await ctx.reply("🧹 PPV videos removed. Send new ones with the caption /ppvadd.");
  });

  // 📥 Admin : enregistrement des vidéos PPV (légende /ppvadd, album accepté)
  bot.on(["message:video", "message:document"], async (ctx, next) => {
    if (ctx.from?.id !== ADMIN_ID) return next();
    const msg = ctx.message;
    if (/^\/ppvpreview\b/i.test((msg.caption ?? "").trim())) {
      const file =
        msg.video ?? (msg.document?.mime_type?.startsWith("video/") ? msg.document : undefined);
      if (!file || (file.file_size ?? 0) > 20 * 1_048_576) {
        await ctx.reply("❌ Send a video under 20 MB with the caption /ppvpreview.");
        return;
      }
      const key = ppvModel(await loadSettings())?.key ?? PPV_DEFAULT_MODEL;
      await setPpvPreview(key, {
        f: file.file_id,
        u: file.file_unique_id,
        d: "duration" in file ? Number(file.duration ?? 0) : 0,
        b: file.file_size ?? 0,
        m: msg.message_id,
      });
      await ctx.reply("✅ This video is now the FREE preview: the voice with the fan's name is put on it.");
      return;
    }
    const cmd = (msg.caption ?? "").trim().match(/^\/ppvadd(?:@\w+)?(?:\s+([a-z]+))?/i);
    let modelKey: string | null = null;
    if (cmd) {
      modelKey = (cmd[1] ?? ppvModel(await loadSettings())?.key ?? PPV_DEFAULT_MODEL).toLowerCase();
      if (msg.media_group_id) await armPpvGroup(msg.media_group_id, modelKey);
    } else if (msg.media_group_id) {
      // Les autres vidéos d'un album arrivent sans légende, parfois AVANT la
      // première : on attend un instant que l'album soit « armé ».
      for (let i = 0; i < 10 && !modelKey; i++) {
        modelKey = await ppvGroupModel(msg.media_group_id).catch(() => null);
        if (!modelKey) await sleep(400);
      }
    }
    if (!modelKey) return next();
    const model = modelByKey(modelKey);
    if (!model) {
      await ctx.reply(`❌ Unknown voice "${modelKey}".`);
      return;
    }
    const file =
      msg.video ?? (msg.document?.mime_type?.startsWith("video/") ? msg.document : undefined);
    if (!file) {
      await ctx.reply("❌ That's not a video.");
      return;
    }
    const size = file.file_size ?? 0;
    if (size > 20 * 1_048_576) {
      await ctx.reply(
        `❌ Too big (${(size / 1_048_576).toFixed(0)} MB): a bot can only reuse videos up to 20 MB. Send the compressed version.`
      );
      return;
    }
    const pos = await addPpvPart(model.key, {
      f: file.file_id,
      u: file.file_unique_id,
      d: "duration" in file ? Number(file.duration ?? 0) : 0,
      b: size,
      m: msg.message_id,
    });
    await ctx.reply(
      pos === null
        ? "ℹ️ This video was already saved."
        : `✅ PPV video saved for ${modelLabel(model)} (${(size / 1_048_576).toFixed(1)} MB). Check the order with /ppvlist.`
    );
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();

    if (text.startsWith("/")) {
      await ctx.reply("Unknown command. Use /voice, /ppv, /level, /help or /stats.");
      return;
    }

    if (text.length > MAX_CHARS * MAX_PARTS) {
      await ctx.reply(
        `❌ Text too long: ${text.length}/${MAX_CHARS * MAX_PARTS} characters max. Shorten it or split it into several messages.`
      );
      return;
    }

    const [selectedKey, storedLevel] = await Promise.all([
      getSelectedModel(ctx.from.id),
      getIntensity(ctx.from.id).catch(() => null),
    ]);
    const model = selectedKey ? modelByKey(selectedKey) : undefined;
    if (!model) {
      await sendModelPicker(
        ctx,
        "⚠️ STOP! Pick the girl first.\n\n👇 Tap a button, THEN send your text again:"
      );
      return;
    }
    const intensity = storedLevel ?? DEFAULT_INTENSITY;

    // Mémorisé 30 min pour le bouton « 🔁 Try again » en cas d'échec
    await setLastText(ctx.from.id, text).catch(() => {});

    // Texte long → plusieurs voice notes numérotées, dans l'ordre
    const chunks = splitLongText(text, MAX_CHARS);
    if (chunks.length > 1) {
      await ctx.reply(
        `📚 Long text — I'll send ${chunks.length} parts × 3 versions each, in order. Hold on…`
      );
    }

    // Réponse 200 immédiate au webhook, génération en arrière-plan (Fluid Compute)
    waitUntil(
      (async () => {
        for (let i = 0; i < chunks.length; i++) {
          await generateAndReply(
            ctx,
            model,
            chunks[i],
            ctx.message.message_id,
            ctx.from.id,
            intensity,
            chunks.length > 1 ? `${i + 1}/${chunks.length}` : undefined
          );
        }
      })()
    );
  });

  // 🎬 « Video » sous un vocal : même prise, en vidéo fond noir (MP4 vertical)
  bot.callbackQuery(/^vid:([a-z0-9]{6,32})$/, async (ctx) => {
    const token = ctx.match[1];
    const src = await getVideoSource(token).catch(() => null);
    if (!src) {
      await ctx.answerCallbackQuery({
        text: "This voice note is too old — make it again, then tap 🎬.",
      });
      return;
    }
    if (!(await lockVideo(token).catch(() => true))) {
      await ctx.answerCallbackQuery({ text: "🎬 Already on its way…" });
      return;
    }
    await ctx.answerCallbackQuery({ text: "🎬 Making the video…" });
    const replyTo = ctx.callbackQuery.message?.message_id;
    const userId = ctx.from.id;
    waitUntil(
      (async () => {
        try {
          await ctx.replyWithChatAction("upload_video").catch(() => {});
          const file = await ctx.api.getFile(src.f);
          if (!file.file_path) throw new Error("file_path absent");
          const res = await fetch(
            `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`
          );
          if (!res.ok) throw new Error(`téléchargement du vocal: ${res.status}`);
          const { video, duration } = await blackVideoFromAudio(
            Buffer.from(await res.arrayBuffer())
          );
          const model = modelByKey(src.m);
          await ctx.replyWithVideo(new InputFile(video, "video.mp4"), {
            width: VIDEO_WIDTH,
            height: VIDEO_HEIGHT,
            duration,
            supports_streaming: true,
            caption: `🎬 ${model ? modelLabel(model) : "Voice"}${src.s ? ` · ${src.s}` : ""} — black-screen video, ready to send`,
            ...(replyTo
              ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
              : {}),
          });
          await recordVideo(userId, src.m).catch(() => {});
        } catch (err) {
          console.error("Vidéo échouée:", err);
          await unlockVideo(token).catch(() => {});
          await ctx
            .reply("❌ Couldn't make the video. Tap 🎬 again; if it keeps failing, tell the admin.")
            .catch(() => {});
        }
      })()
    );
  });

  // 🔁 « Try again » après un échec : re-génère le dernier texte (30 min max)
  bot.callbackQuery("retry", async (ctx) => {
    const [last, selectedKey, storedLevel] = await Promise.all([
      getLastText(ctx.from.id).catch(() => null),
      getSelectedModel(ctx.from.id),
      getIntensity(ctx.from.id).catch(() => null),
    ]);
    if (!last) {
      await ctx.answerCallbackQuery({
        text: "Nothing to retry — send your text again.",
      });
      return;
    }
    const model = selectedKey ? modelByKey(selectedKey) : undefined;
    if (!model) {
      await ctx.answerCallbackQuery({ text: "Pick the girl first: /voice" });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Retrying… 🎙️" });
    const intensity = storedLevel ?? DEFAULT_INTENSITY;
    const chunks = splitLongText(last, MAX_CHARS);
    const replyTo = ctx.callbackQuery.message?.message_id ?? 0;
    waitUntil(
      (async () => {
        for (let i = 0; i < chunks.length; i++) {
          await generateAndReply(
            ctx,
            model,
            chunks[i],
            replyTo,
            ctx.from.id,
            intensity,
            chunks.length > 1 ? `${i + 1}/${chunks.length}` : undefined
          );
        }
      })()
    );
  });

  // Autres types de messages (photo, vocal, etc.)
  bot.on("message", async (ctx) => {
    await ctx.reply("🎙️ Send me text only — I'll turn it into a voice note.");
  });

  return bot;
}

// ---------- Handler Vercel ----------
let handleUpdate: ((req: Request) => Promise<Response>) | null = null;

// ---------- 🔧 Porte d'admin : installer les vidéos PPV sans Telegram ----------
// Active SEULEMENT si la variable PPV_SETUP_SECRET existe (≥ 24 caractères) et
// que l'appel porte ce secret dans l'en-tête x-setup-secret. Sinon : 404.
//   ?setup=chunk&id=…&i=…   corps = un morceau (≤ 700 Ko) de la vidéo
//   ?setup=finish&id=…&n=…&name=…   réassemble, publie la vidéo dans le chat
//                                   privé de l'admin, l'enregistre (ordre d'envoi)
//   ?setup=list                     vidéos PPV enregistrées
//   ?setup=test&name=…              lance un vrai /ppv vers le chat de l'admin
async function handleSetup(req: Request, u: URL): Promise<Response> {
  const secret = process.env.PPV_SETUP_SECRET?.trim() ?? "";
  if (secret.length < 24 || req.headers.get("x-setup-secret") !== secret) {
    return new Response("not found", { status: 404 });
  }
  const action = u.searchParams.get("setup");
  const id = (u.searchParams.get("id") ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 32);
  const model = ppvModel(await loadSettings())?.key ?? PPV_DEFAULT_MODEL;

  if (action === "chunk") {
    const i = Number(u.searchParams.get("i"));
    const body = Buffer.from(await req.arrayBuffer());
    if (!id || !Number.isInteger(i) || i < 0 || body.length === 0 || body.length > 760_000) {
      return Response.json({ ok: false, error: "morceau invalide" }, { status: 400 });
    }
    await setUploadChunk(id, i, body.toString("base64"));
    return Response.json({ ok: true, i, bytes: body.length });
  }

  if (action === "finish") {
    const n = Number(u.searchParams.get("n"));
    const name = (u.searchParams.get("name") ?? "ppv.mp4").replace(/[^\w.-]/g, "_").slice(0, 60);
    if (!id || !Number.isInteger(n) || n < 1 || n > 40) {
      return Response.json({ ok: false, error: "paramètres invalides" }, { status: 400 });
    }
    const parts: Buffer[] = [];
    for (let i = 0; i < n; i++) {
      const b64 = await getUploadChunk(id, i);
      if (!b64) return Response.json({ ok: false, error: `morceau ${i} manquant` }, { status: 400 });
      parts.push(Buffer.from(b64, "base64"));
    }
    const video = Buffer.concat(parts);
    const bot = new Bot(process.env.BOT_TOKEN!);
    try {
      const sent = await bot.api.sendVideo(ADMIN_ID, new InputFile(video, name), {
        caption: `🗂️ PPV video saved (${name})`,
        supports_streaming: true,
      });
      const file = sent.video;
      if (!file) throw new Error("Telegram n'a pas renvoyé de fichier");
      const part = {
        f: file.file_id,
        u: file.file_unique_id,
        d: Number(file.duration ?? 0),
        b: file.file_size ?? video.length,
        m: sent.message_id,
      };
      const pos =
        u.searchParams.get("role") === "preview"
          ? (await setPpvPreview(model, part), "preview")
          : await addPpvPart(model, part);
      await deleteUploadChunks(id, n);
      return Response.json({ ok: true, position: pos, bytes: video.length, messageId: sent.message_id });
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 502 }
      );
    }
  }

  // ?setup=fixed&line=paid1  corps = l'audio de la prise choisie (≤ 760 Ko) :
  // devient la partie FIXE de cette phrase pour tous les fans
  if (action === "fixed") {
    const line = u.searchParams.get("line");
    const audio = Buffer.from(await req.arrayBuffer());
    if (!line || !LINE_KEYS.includes(line as LineKey) || audio.length === 0 || audio.length > 760_000) {
      return Response.json({ ok: false, error: "phrase ou audio invalide" }, { status: 400 });
    }
    const cfg = await loadSettings();
    await setPpvFixed(model, line, {
      src: "tts",
      a: audio.toString("base64"),
      at: new Date().toISOString(),
      t: cfg.lines[line as LineKey].fixed,
    });
    return Response.json({ ok: true, line, bytes: audio.length });
  }

  if (action === "list") {
    const parts = await getPpvParts(model);
    return Response.json({
      ok: true,
      parts: parts.map((p, i) => ({ role: i === 0 ? "PPV 1" : "unused", seconds: p.d, bytes: p.b, m: p.m })),
    });
  }

  if (action === "test") {
    const name = cleanFanName(u.searchParams.get("name") ?? "Test") ?? "Test";
    const bot = createBot();
    await bot.init();
    const now = Math.floor(Date.now() / 1000);
    const admin = { id: ADMIN_ID, is_bot: false, first_name: "Admin" };
    const text = `/ppv ${name}`;
    await bot.handleUpdate({
      update_id: now,
      message: {
        message_id: 1,
        date: now,
        chat: { id: ADMIN_ID, type: "private", first_name: "Admin" },
        from: admin,
        text,
        entities: [{ type: "bot_command", offset: 0, length: 4 }],
      },
    } as Parameters<typeof bot.handleUpdate>[0]);
    return Response.json({ ok: true, started: text });
  }

  return Response.json({ ok: false, error: "action inconnue" }, { status: 400 });
}

export async function POST(req: Request): Promise<Response> {
  const setupUrl = new URL(req.url);
  if (setupUrl.searchParams.has("setup")) return handleSetup(req, setupUrl);
  try {
    if (!handleUpdate) {
      handleUpdate = webhookCallback(createBot(), "std/http", {
        secretToken: process.env.TELEGRAM_WEBHOOK_SECRET,
      });
    }
    return await handleUpdate(req);
  } catch (err) {
    console.error("Erreur webhook:", err);
    // Toujours 200 pour éviter que Telegram ne renvoie l'update en boucle
    return new Response("ok");
  }
}

// Diagnostic : indique quelles variables d'environnement sont présentes
// (booléens uniquement, aucune valeur n'est exposée)
export async function GET(req: Request): Promise<Response> {
  // Diagnostic de traduction DEPUIS le serveur (?t=texte&s=secret) : permet de
  // vérifier le contournement du filtre Gemini sans passer par Telegram.
  const u = new URL(req.url);
  // Auto-test du générateur vidéo sur le serveur (ffmpeg embarqué) : aucun
  // secret exposé, résultat mis en cache par instance.
  if (u.searchParams.get("diag") === "video") {
    return Response.json({ video: await videoSelfTest() });
  }
  const t = u.searchParams.get("t");
  if (t) {
    if (u.searchParams.get("s") !== (process.env.DIAG_SECRET ?? process.env.TELEGRAM_WEBHOOK_SECRET)) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    try {
      const fr = t.slice(0, 500);
      const level = Number(u.searchParams.get("lvl") ?? DEFAULT_INTENSITY);
      const style = u.searchParams.get("style") ?? undefined;
      const tagged = await enrichWithEmotionTags(fr, level, Boolean(style), style);
      return Response.json({ ok: true, fr, tagged, tagsAdded: tagged !== fr, style: style ?? null });
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return Response.json({
    status: "Fish Voice Bot : fonction en ligne ✅",
    env: {
      BOT_TOKEN: Boolean(process.env.BOT_TOKEN),
      FISH_API_KEY: Boolean(process.env.FISH_API_KEY),
      TELEGRAM_WEBHOOK_SECRET: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
      UPSTASH_REDIS: hasRedisEnv(),
    },
    enrichissementEmotions: enrichProvider(),
    voixConfigurees: ACTIVE_MODELS.map((m) => modelLabel(m)),
  });
}
