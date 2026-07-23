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
  getLastText,
  getSelectedModel,
  hasRedisEnv,
  readStats,
  recordGeneration,
  resetStats,
  setIntensity,
  setLastText,
  setSelectedModel,
  shouldWarnCredits,
} from "../lib/redis.js";
import { FishError, generateVoice, getFishCredits } from "../lib/fish.js";
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
// Affiché sous chaque vocal et sous le choix de voix : le niveau actif porte un ✅.
function intensityKeyboard(current?: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  const entries = Object.entries(INTENSITY_LEVELS);
  entries.forEach(([level, cfg], i) => {
    const active = Number(level) === current;
    kb.text(`${active ? "✅ " : ""}${cfg.label}`, `level:${level}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
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
    // Ajout automatique des tags d'émotion (texte brut conservé en cas d'échec)
    const finalText = await enrichWithEmotionTags(text, intensity);
    const audio = await generateVoice(finalText, model.referenceId);
    // Légende : la voix utilisée (+ n° de partie pour les textes longs) et,
    // si des tags ont été ajoutés, le texte utilisé (limite Telegram : 1024)
    const caption = [
      `🎤 ${model.name}${partLabel ? ` · part ${partLabel}` : ""}`,
      finalText !== text ? `🎭 ${finalText}` : null,
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 1024);
    // Boutons d'intensité sous chaque vocal : changement en un tap
    await ctx.replyWithVoice(new InputFile(audio, "voice.mp3"), {
      reply_parameters: {
        message_id: messageId,
        allow_sending_without_reply: true,
      },
      caption,
      reply_markup: intensityKeyboard(intensity),
    });
    await recordGeneration(userId, model.key, text.length);

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
        "3️⃣ Write your message as if SHE was the one talking\n" +
        "4️⃣ Send the message\n" +
        "5️⃣ Wait a few seconds\n" +
        "6️⃣ You receive the voice note 🎤 → send it to the client\n\n" +
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
      .editMessageReplyMarkup({ reply_markup: intensityKeyboard(level) })
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
        `📚 Long text — I'll send ${chunks.length} voice notes, in order. Hold on…`
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
