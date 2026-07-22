import { Bot, Context, InlineKeyboard, InputFile, webhookCallback } from "grammy";
import { waitUntil } from "@vercel/functions";
import {
  ACTIVE_MODELS,
  ADMIN_ID,
  MAX_CHARS,
  VoiceModel,
  isAllowed,
  modelByKey,
  operatorName,
} from "../lib/config.js";
import {
  getIntensity,
  getSelectedModel,
  hasRedisEnv,
  readStats,
  recordGeneration,
  resetStats,
  setIntensity,
  setSelectedModel,
} from "../lib/redis.js";
import { FishError, generateVoice } from "../lib/fish.js";
import {
  DEFAULT_INTENSITY,
  INTENSITY_LEVELS,
  enrichProvider,
  enrichWithEmotionTags,
} from "../lib/enrich.js";

export const maxDuration = 60;

// ---------- Clavier de sélection ----------
function modelKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const m of ACTIVE_MODELS) kb.text(`🎤 ${m.name}`, `voice:${m.key}`).row();
  return kb;
}

async function sendModelPicker(ctx: Context, intro: string): Promise<void> {
  await ctx.reply(intro, { reply_markup: modelKeyboard() });
}

// ---------- Clavier d'intensité ----------
function intensityKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const [level, cfg] of Object.entries(INTENSITY_LEVELS)) {
    kb.text(cfg.label, `level:${level}`).row();
  }
  return kb;
}

// ---------- Génération TTS (exécutée après la réponse 200 via waitUntil) ----------
async function generateAndReply(
  ctx: Context,
  model: VoiceModel,
  text: string,
  messageId: number,
  userId: number,
  intensity: number
): Promise<void> {
  try {
    await ctx.replyWithChatAction("record_voice").catch(() => {});
    // Ajout automatique des tags d'émotion (texte brut conservé en cas d'échec)
    const finalText = await enrichWithEmotionTags(text, intensity);
    const audio = await generateVoice(finalText, model.referenceId);
    // Si des tags ont été ajoutés, on les montre en légende pour que
    // l'opérateur voie ce qui a été utilisé (limite caption Telegram : 1024)
    const caption =
      finalText !== text ? `🎭 ${finalText}`.slice(0, 1024) : undefined;
    await ctx.replyWithVoice(new InputFile(audio, "voice.mp3"), {
      reply_parameters: { message_id: messageId },
      caption,
    });
    await recordGeneration(userId, model.key, text.length);
  } catch (err) {
    console.error("Erreur de génération TTS:", err);
    const msg =
      err instanceof FishError
        ? err.userMessage
        : "❌ Unexpected error during generation. Try again; if it keeps happening, tell the admin.";
    await ctx.reply(msg).catch(() => {});
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
        "The hotter the level, the more breathing, moaning and sensual pauses in the voice.\n\n" +
        "👇 Pick a level:",
      { reply_markup: intensityKeyboard() }
    );
  });

  bot.command(["help", "aide"], async (ctx) => {
    await ctx.reply(
      "📖 TUTORIAL — HOW TO MAKE A VOICE NOTE\n\n" +
        "1️⃣ Type /voice\n" +
        "2️⃣ Tap the girl\n" +
        "3️⃣ Write your message as if SHE was the one talking\n" +
        "4️⃣ Send the message\n" +
        "5️⃣ Wait a few seconds\n" +
        "6️⃣ You receive the voice note 🎤 → send it to the client\n\n" +
        "✅ DO THIS:\n" +
        "• Short sentences, like a real voice note\n" +
        "• Write normally, emotions are added AUTOMATICALLY ✨\n\n" +
        "🌡️ INTENSITY: type /level to set how sexual the voice sounds:\n" +
        "🌶️ Light → 🌶️🌶️ Hot → 🌶️🌶️🌶️ Very hot\n" +
        "The hotter, the more breathing, moaning and pauses.\n\n" +
        "❌ DON'T DO THIS:\n" +
        `• A text longer than ${MAX_CHARS} characters (the bot will refuse)\n` +
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

  bot.command("stats", async (ctx) => {
    if (ctx.from?.id !== ADMIN_ID) return; // réservé admin, silencieux pour les autres

    if (ctx.match?.trim().toLowerCase() === "reset") {
      await resetStats();
      await ctx.reply("🧹 Stats reset to zero.");
      return;
    }

    const stats = await readStats();

    const modelLines = ACTIVE_MODELS.map((m) => {
      const gen = Number(stats.genByModel[m.key] ?? 0);
      const chars = Number(stats.charsByModel[m.key] ?? 0);
      return `• ${m.name}: ${gen} voice notes, ${chars} characters`;
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
          return `• ${operatorName(id)}: ${gen} voice notes, ${chars} characters`;
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
    await ctx.answerCallbackQuery({ text: `Intensity: ${cfg.label}` });
    await ctx
      .editMessageText(
        `✅ Intensity set: ${cfg.label}\n\n` +
          "All your next voice notes will use this level.\n" +
          "(/level to change it anytime)"
      )
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
    await ctx.answerCallbackQuery({ text: `Voice selected: ${model.name}` });
    await ctx
      .editMessageText(
        `✅ Voice selected: ${model.name}\n\n` +
          "📝 STEP 2 of 3: write your message\n" +
          "• Write as if SHE was the one talking\n" +
          "• Short, natural sentences\n" +
          "• Write normally: emotions are added AUTOMATICALLY ✨\n\n" +
          "Example:\n" +
          "Hey you, I missed you today...\n\n" +
          "📤 STEP 3 of 3: send your message, wait a few seconds, and you get the voice note 🎤\n\n" +
          "(/voice change girl • /level set intensity 🌶️ • /help tutorial)"
      )
      .catch(() => {});
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();

    if (text.startsWith("/")) {
      await ctx.reply("Unknown command. Use /voice, /level, /help or /stats.");
      return;
    }

    if (text.length > MAX_CHARS) {
      await ctx.reply(
        `❌ Text too long: ${text.length}/${MAX_CHARS} characters. Shorten it or split it into several messages.`
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

    // Réponse 200 immédiate au webhook, génération en arrière-plan (Fluid Compute)
    waitUntil(
      generateAndReply(
        ctx,
        model,
        text,
        ctx.message.message_id,
        ctx.from.id,
        intensity
      )
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
export function GET(): Response {
  return Response.json({
    status: "Fish Voice Bot : fonction en ligne ✅",
    env: {
      BOT_TOKEN: Boolean(process.env.BOT_TOKEN),
      FISH_API_KEY: Boolean(process.env.FISH_API_KEY),
      TELEGRAM_WEBHOOK_SECRET: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
      UPSTASH_REDIS: hasRedisEnv(),
    },
    enrichissementEmotions: enrichProvider(),
    voixConfigurees: ACTIVE_MODELS.map((m) => m.name),
  });
}
