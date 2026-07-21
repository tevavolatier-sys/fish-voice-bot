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
        : "❌ Erreur inattendue pendant la génération. Réessaie ; si ça persiste, préviens l'admin.";
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

  bot.command(["start", "voix"], async (ctx) => {
    await sendModelPicker(
      ctx,
      "🎙️ ÉTAPE 1 sur 3\n\n" +
        "👇 Clique sur la fille dont tu veux la voix :"
    );
  });

  bot.command("niveau", async (ctx) => {
    const current =
      (await getIntensity(ctx.from!.id).catch(() => null)) ?? DEFAULT_INTENSITY;
    const label = INTENSITY_LEVELS[current]?.label ?? "?";
    await ctx.reply(
      "🌡️ INTENSITÉ DES VOCAUX\n\n" +
        `Niveau actuel : ${label}\n\n` +
        "Plus le niveau est chaud, plus la voix aura de souffle, de gémissements et de pauses sensuelles.\n\n" +
        "👇 Choisis le niveau :",
      { reply_markup: intensityKeyboard() }
    );
  });

  bot.command("aide", async (ctx) => {
    await ctx.reply(
      "📖 TUTO — COMMENT FAIRE UN VOCAL\n\n" +
        "1️⃣ Tape /voix\n" +
        "2️⃣ Clique sur la fille\n" +
        "3️⃣ Écris ton message comme si c'était ELLE qui parlait\n" +
        "4️⃣ Envoie le message\n" +
        "5️⃣ Attends quelques secondes\n" +
        "6️⃣ Tu reçois le vocal 🎤 → transfère-le au client\n\n" +
        "✅ FAIS ÇA :\n" +
        "• Des phrases courtes, comme un vrai vocal\n" +
        "• Écris normalement, les émotions s'ajoutent TOUTES SEULES ✨\n\n" +
        "🌡️ INTENSITÉ : tape /niveau pour régler à quel point la voix est sexuelle :\n" +
        "🧊 Pas sexuel → 🌶️ Léger → 🌶️🌶️ Chaud → 🌶️🌶️🌶️ Très chaud\n" +
        "Plus c'est chaud, plus il y a de souffle, de gémissements et de pauses.\n\n" +
        "❌ FAIS PAS ÇA :\n" +
        `• Un texte de plus de ${MAX_CHARS} caractères (le bot refusera)\n` +
        "• Écrire en mode robot (« Bonjour. Comment allez-vous. »)\n\n" +
        "————————————\n" +
        "🎭 MODE PRO (pas obligé !)\n" +
        "Tu peux placer toi-même des tags [comme ça] dans ton texte.\n" +
        "Si tu en mets, le bot n'ajoute rien et respecte tes tags.\n\n" +
        "😊 Émotions positives :\n" +
        "[excited] [delighted] [joyful] [satisfied] [proud] [confident]\n" +
        "[relaxed] [grateful] [moved] [amused] [curious] [interested]\n\n" +
        "😢 Émotions négatives :\n" +
        "[sad] [unhappy] [upset] [depressed] [worried] [anxious]\n" +
        "[nervous] [scared] [panicked] [angry] [furious] [frustrated]\n" +
        "[impatient] [guilty] [embarrassed] [awkward] [hesitating]\n\n" +
        "😲 Autres émotions :\n" +
        "[surprised] [astonished] [confused] [serious] [sincere]\n" +
        "[comforting] [empathetic] [sarcastic]\n\n" +
        "🗣️ Façons de parler :\n" +
        "[whispering] [soft tone] [shouting] [screaming] [in a hurry tone]\n\n" +
        "🔊 Sons et respirations :\n" +
        "[laughing] [chuckling] [giggling] [sobbing] [crying loudly]\n" +
        "[sighing] [breath] [panting] [groaning] [cough] [lip-smacking]\n\n" +
        "⏸️ Pauses :\n" +
        "[break] [long-break]\n\n" +
        "Exemple :\n" +
        "[whispering] Coucou toi... [break] [excited] j'ai une surprise pour toi !"
    );
  });

  bot.command("stats", async (ctx) => {
    if (ctx.from?.id !== ADMIN_ID) return; // réservé admin, silencieux pour les autres

    if (ctx.match?.trim().toLowerCase() === "reset") {
      await resetStats();
      await ctx.reply("🧹 Statistiques remises à zéro.");
      return;
    }

    const stats = await readStats();

    const modelLines = ACTIVE_MODELS.map((m) => {
      const gen = Number(stats.genByModel[m.key] ?? 0);
      const chars = Number(stats.charsByModel[m.key] ?? 0);
      return `• ${m.name} : ${gen} générations, ${chars} caractères`;
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
          return `• ${operatorName(id)} : ${gen} générations, ${chars} caractères`;
        })
        .join("\n") || "• Aucune génération pour l'instant";

    await ctx.reply(
      "📊 Statistiques (cumul global)\n\n" +
        "Par modèle :\n" +
        modelLines +
        "\n\nPar opérateur :\n" +
        userLines +
        "\n\n(/stats reset pour remettre à zéro)"
    );
  });

  // Sélection du niveau d'intensité via bouton
  bot.callbackQuery(/^level:(\d)$/, async (ctx) => {
    const level = Number(ctx.match[1]);
    const cfg = INTENSITY_LEVELS[level];
    if (!cfg) {
      await ctx.answerCallbackQuery({ text: "Niveau inconnu." });
      return;
    }
    await setIntensity(ctx.from.id, level);
    await ctx.answerCallbackQuery({ text: `Intensité : ${cfg.label}` });
    await ctx
      .editMessageText(
        `✅ Intensité réglée : ${cfg.label}\n\n` +
          "Tous tes prochains vocaux utiliseront ce niveau.\n" +
          "(/niveau pour changer à tout moment)"
      )
      .catch(() => {});
  });

  // Sélection d'une modèle via bouton
  bot.callbackQuery(/^voice:(.+)$/, async (ctx) => {
    const model = modelByKey(ctx.match[1]);
    if (!model) {
      await ctx.answerCallbackQuery({ text: "Modèle inconnue." });
      return;
    }
    await setSelectedModel(ctx.from.id, model.key);
    await ctx.answerCallbackQuery({ text: `Voix sélectionnée : ${model.name}` });
    await ctx
      .editMessageText(
        `✅ Voix choisie : ${model.name}\n\n` +
          "📝 ÉTAPE 2 sur 3 : écris ton message\n" +
          `• Écris comme si c'était ELLE qui parlait\n` +
          "• Des phrases courtes et naturelles\n" +
          "• Écris normalement : les émotions sont ajoutées TOUTES SEULES ✨\n\n" +
          "Exemple :\n" +
          "Coucou toi, tu m'as manqué aujourd'hui...\n\n" +
          "📤 ÉTAPE 3 sur 3 : envoie ton message, attends quelques secondes, et tu reçois le vocal 🎤\n\n" +
          "(/voix changer de fille • /niveau régler l'intensité 🌶️ • /aide tuto)"
      )
      .catch(() => {});
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();

    if (text.startsWith("/")) {
      await ctx.reply(
        "Commande inconnue. Utilise /voix, /niveau, /aide ou /stats."
      );
      return;
    }

    if (text.length > MAX_CHARS) {
      await ctx.reply(
        `❌ Texte trop long : ${text.length}/${MAX_CHARS} caractères. Raccourcis-le ou découpe-le en plusieurs messages.`
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
        "⚠️ STOP ! Il faut d'abord choisir la fille.\n\n👇 Clique sur un bouton, PUIS renvoie ton texte :"
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
    await ctx.reply(
      "🎙️ Envoie-moi uniquement du texte à transformer en voice note."
    );
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
