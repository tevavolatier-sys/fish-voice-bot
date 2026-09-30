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
  readStats,
  readVideoStats,
  recordGeneration,
  recordVideo,
  resetStats,
  setIntensity,
  setLastText,
  setSelectedModel,
  setVideoSource,
  shouldWarnCredits,
  unlockVideo,
} from "../lib/redis.js";
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
        "🎬 Fan wants a VIDEO (\"a video with my name\")? Tap 🎬 Video under the version you like: you get the same voice as a black-screen video, ready to send.\n\n" +
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

    const [stats, videos] = await Promise.all([
      readStats(),
      readVideoStats().catch(() => ({ byModel: {}, byUser: {} }) as Awaited<ReturnType<typeof readVideoStats>>),
    ]);
    const vidSuffix = (n: number) => (n > 0 ? `, 🎬 ${n} video${n > 1 ? "s" : ""}` : "");

    const modelLines = ACTIVE_MODELS.map((m) => {
      const gen = Number(stats.genByModel[m.key] ?? 0);
      const chars = Number(stats.charsByModel[m.key] ?? 0);
      return `• ${modelLabel(m)}: ${gen} voice notes, ${chars} characters${vidSuffix(Number(videos.byModel[m.key] ?? 0))}`;
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
          return `• ${operatorName(id)}: ${gen} voice notes, ${chars} characters${vidSuffix(Number(videos.byUser[id] ?? 0))}`;
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

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();

    if (text.startsWith("/")) {
      await ctx.reply("Unknown command. Use /voice, /level, /help or /stats.");
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

export async function POST(req: Request): Promise<Response> {
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
