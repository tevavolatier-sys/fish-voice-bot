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
  getPendingVoice,
  getSelectedModel,
  hasRedisEnv,
  readStats,
  recordGeneration,
  resetStats,
  setIntensity,
  setPendingVoice,
  setSelectedModel,
} from "../lib/redis.js";
import { FishError, generateVoice } from "../lib/fish.js";
import {
  DEFAULT_INTENSITY,
  DEFAULT_MOOD,
  INTENSITY_LEVELS,
  MOODS,
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

// ---------- Clavier unifié : ambiances 🎭 + intensité 🌡️ ----------
// TOUJOURS affiché ensemble (demande de Teva : l'intensité d'excitation
// reste accessible en permanence). Un tap d'ambiance = génération/re-
// génération du dernier texte ; un tap d'intensité = change le niveau (✅).
function voiceKeyboard(currentLevel?: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text(MOODS[DEFAULT_MOOD].label + " — let the bot feel it", `mood:${DEFAULT_MOOD}`).row();
  const keys = Object.keys(MOODS).filter((k) => k !== DEFAULT_MOOD);
  keys.forEach((k, i) => {
    kb.text(MOODS[k].label, `mood:${k}`);
    if (i % 4 === 3) kb.row();
  });
  const entries = Object.entries(INTENSITY_LEVELS);
  entries.forEach(([level, cfg], i) => {
    const active = Number(level) === currentLevel;
    kb.text(`${active ? "✅ " : ""}${cfg.label}`, `level:${level}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

// ---------- Génération TTS (exécutée après la réponse 200 via waitUntil) ----------
async function generateAndReply(
  ctx: Context,
  model: VoiceModel,
  text: string,
  messageId: number,
  userId: number,
  intensity: number,
  moodKey: string = DEFAULT_MOOD
): Promise<void> {
  try {
    await ctx.replyWithChatAction("record_voice").catch(() => {});
    // Ajout automatique des tags d'émotion (texte brut conservé en cas d'échec)
    const finalText = await enrichWithEmotionTags(text, intensity, false, moodKey);
    const audio = await generateVoice(finalText, model.referenceId);
    // Si des tags ont été ajoutés, on les montre en légende pour que
    // l'opérateur voie ce qui a été utilisé (limite caption Telegram : 1024)
    const moodLabel = MOODS[moodKey]?.label ?? MOODS[DEFAULT_MOOD].label;
    const caption =
      finalText !== text ? `${moodLabel} · ${finalText}`.slice(0, 1024) : undefined;
    // Boutons sous chaque vocal : ambiances (re-génère le MÊME texte) +
    // intensité toujours accessible (✅ sur le niveau actif).
    await ctx.replyWithVoice(new InputFile(audio, "voice.mp3"), {
      // Le message d'origine peut avoir été supprimé entre-temps : on envoie
      // quand même le vocal au lieu d'échouer.
      reply_parameters: {
        message_id: messageId,
        allow_sending_without_reply: true,
      },
      caption,
      reply_markup: voiceKeyboard(intensity),
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
        "😇 Normal = no sexualization at all.\n" +
        "The hotter the level, the more breathing, moaning and sensual pauses.\n\n" +
        "👇 Pick a level:",
      { reply_markup: voiceKeyboard(current) }
    );
  });

  bot.command(["help", "aide"], async (ctx) => {
    await ctx.reply(
      "📖 TUTORIAL — HOW TO MAKE A VOICE NOTE\n\n" +
        "1️⃣ Type /voice\n" +
        "2️⃣ Tap the girl\n" +
        "3️⃣ Write your message as if SHE was the one talking, and send it\n" +
        "4️⃣ Tap the VIBE 🎭 (🥰 Sweet, 🔥 Hot, 😢 Sad… or 🎲 Auto)\n" +
        "5️⃣ You receive the voice note 🎤 → send it to the client\n\n" +
        "🔁 NOT HAPPY WITH IT? Tap another vibe UNDER the voice note:\n" +
        "the same text is re-recorded in that new vibe. Magic. ✨\n\n" +
        "✅ DO THIS:\n" +
        "• Short sentences, like a real voice note\n" +
        "• Write normally, emotions are added AUTOMATICALLY ✨\n\n" +
        "🌡️ INTENSITY (how sexual the voice gets): /level\n" +
        "😇 Normal (no sexualization) → 🌶️ Light → 🌶️🌶️ Hot → 🌶️🌶️🌶️ Very hot\n" +
        "The vibe = the emotion · the level = how hot. They work together.\n\n" +
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
    await ctx.answerCallbackQuery({
      text: `${cfg.label} — applies to your next voice notes`,
    });
    // Le clavier peut être sous un message texte OU sous un vocal :
    // on met juste à jour les boutons (déplacement du ✅).
    await ctx
      .editMessageReplyMarkup({ reply_markup: voiceKeyboard(level) })
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
    const currentLevel =
      (await getIntensity(ctx.from.id).catch(() => null)) ?? DEFAULT_INTENSITY;
    await ctx
      .editMessageText(
        `✅ Voice selected: ${model.name}\n\n` +
          "📝 STEP 2: write your message and send it\n" +
          "• Write as if SHE was the one talking\n" +
          "• Short, natural sentences\n\n" +
          "Example:\n" +
          "Hey you, I missed you today...\n\n" +
          "🎭 STEP 3: tap the VIBE (🥰 🔥 😢 …) → you get the voice note 🎤\n\n" +
          "🌡️ Intensity of the voice — tap to change:",
        { reply_markup: voiceKeyboard(currentLevel) }
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

    // Texte mémorisé 30 min → l'opérateur choisit l'AMBIANCE en un tap.
    // (Les boutons sous le vocal re-génèrent ce même texte.)
    await setPendingVoice(ctx.from.id, {
      text,
      messageId: ctx.message.message_id,
    });
    await ctx.reply("🎭 Last tap — pick the vibe of the voice note 👇", {
      reply_markup: voiceKeyboard(storedLevel ?? DEFAULT_INTENSITY),
      reply_parameters: { message_id: ctx.message.message_id },
    });
  });

  // Choix d'ambiance (🎭) → génération. Le même clavier est sous chaque
  // vocal : un tap re-génère le dernier texte dans une autre ambiance.
  bot.callbackQuery(/^mood:(.+)$/, async (ctx) => {
    const moodKey = ctx.match[1];
    const mood = MOODS[moodKey];
    if (!mood) {
      await ctx.answerCallbackQuery({ text: "Unknown vibe." });
      return;
    }
    const [pending, selectedKey, storedLevel] = await Promise.all([
      getPendingVoice(ctx.from.id).catch(() => null),
      getSelectedModel(ctx.from.id),
      getIntensity(ctx.from.id).catch(() => null),
    ]);
    if (!pending?.text) {
      await ctx.answerCallbackQuery({
        text: "I lost your text (30 min max) — send it again 😉",
      });
      return;
    }
    const model = selectedKey ? modelByKey(selectedKey) : undefined;
    if (!model) {
      await ctx.answerCallbackQuery({ text: "Pick the girl first: /voice" });
      return;
    }
    await ctx.answerCallbackQuery({ text: `${mood.label} — recording… 🎙️` });
    // Sur le message-picker (texte) : on fige le choix et on retire les
    // boutons (évite le double-tap). Sur un vocal (caption), l'édition de
    // texte échoue → on laisse les boutons pour pouvoir re-générer encore.
    await ctx
      .editMessageText(`🎙️ ${mood.label} — generating your voice note…`)
      .catch(() => {});

    waitUntil(
      generateAndReply(
        ctx,
        model,
        pending.text,
        pending.messageId,
        ctx.from.id,
        storedLevel ?? DEFAULT_INTENSITY,
        moodKey
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
