import { Bot, Context, InlineKeyboard, InputFile, webhookCallback } from "grammy";
import { waitUntil } from "@vercel/functions";
import {
  ADMIN_ID,
  MAX_CHARS,
  MODELS,
  VoiceModel,
  isAllowed,
  modelByKey,
  operatorName,
} from "../lib/config";
import {
  getSelectedModel,
  readStats,
  recordGeneration,
  resetStats,
  setSelectedModel,
} from "../lib/redis";
import { FishError, generateVoice } from "../lib/fish";

export const maxDuration = 60;

const bot = new Bot(process.env.BOT_TOKEN ?? "");

// ---------- Whitelist stricte : on ignore silencieusement les inconnus ----------
bot.use(async (ctx, next) => {
  const id = ctx.from?.id;
  if (!id || !isAllowed(id, ctx.chat?.id)) return;
  await next();
});

// ---------- Clavier de sélection ----------
function modelKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const m of MODELS) kb.text(`🎤 ${m.name}`, `voice:${m.key}`).row();
  return kb;
}

async function sendModelPicker(ctx: Context, intro: string): Promise<void> {
  await ctx.reply(intro, { reply_markup: modelKeyboard() });
}

// ---------- Commandes ----------
bot.command(["start", "voix"], async (ctx) => {
  await sendModelPicker(
    ctx,
    "🎙️ Choisis la modèle dont tu veux générer la voix :\n\n" +
      "Ensuite, envoie simplement ton texte (max " +
      MAX_CHARS +
      " caractères) et tu recevras la voice note.\n" +
      "Tape /aide pour la liste des tags d'émotion."
  );
});

bot.command("aide", async (ctx) => {
  await ctx.reply(
    "ℹ️ Mode d'emploi\n\n" +
      "1. /voix pour choisir une modèle\n" +
      "2. Envoie ton texte, tu reçois la voice note\n\n" +
      "🎭 Tags d'émotion Fish Audio (à insérer librement dans le texte) :\n" +
      "[excited] [whisper] [sad] [angry] [surprised] [nervous]\n" +
      "[laughing] [chuckling] [sighing] [crying] [breath]\n" +
      "[soft tone] [shouting] [in a hurry tone]\n\n" +
      "Exemple :\n" +
      "[whisper] Coucou toi... [excited] j'ai une surprise pour toi !\n\n" +
      `⚠️ Limite : ${MAX_CHARS} caractères par message.`
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

  const modelLines = MODELS.map((m) => {
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

// ---------- Sélection d'une modèle via bouton ----------
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
      `✅ Modèle active : ${model.name}\n\nEnvoie ton texte pour générer une voice note. /voix pour changer.`
    )
    .catch(() => {});
});

// ---------- Génération TTS (exécutée après la réponse 200 via waitUntil) ----------
async function generateAndReply(
  ctx: Context,
  model: VoiceModel,
  text: string,
  messageId: number,
  userId: number
): Promise<void> {
  try {
    await ctx.replyWithChatAction("record_voice").catch(() => {});
    const audio = await generateVoice(text, model.referenceId);
    await ctx.replyWithVoice(new InputFile(audio, "voice.mp3"), {
      reply_parameters: { message_id: messageId },
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

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) {
    await ctx.reply("Commande inconnue. Utilise /voix, /aide ou /stats.");
    return;
  }

  if (text.length > MAX_CHARS) {
    await ctx.reply(
      `❌ Texte trop long : ${text.length}/${MAX_CHARS} caractères. Raccourcis-le ou découpe-le en plusieurs messages.`
    );
    return;
  }

  const selectedKey = await getSelectedModel(ctx.from.id);
  const model = selectedKey ? modelByKey(selectedKey) : undefined;
  if (!model) {
    await sendModelPicker(ctx, "⚠️ Choisis d'abord une modèle :");
    return;
  }

  // Réponse 200 immédiate au webhook, génération en arrière-plan (Fluid Compute)
  waitUntil(
    generateAndReply(ctx, model, text, ctx.message.message_id, ctx.from.id)
  );
});

// ---------- Autres types de messages (photo, vocal, etc.) ----------
bot.on("message", async (ctx) => {
  await ctx.reply("🎙️ Envoie-moi uniquement du texte à transformer en voice note.");
});

// ---------- Handler Vercel ----------
const handleUpdate = webhookCallback(bot, "std/http", {
  secretToken: process.env.TELEGRAM_WEBHOOK_SECRET,
});

export async function POST(req: Request): Promise<Response> {
  try {
    return await handleUpdate(req);
  } catch (err) {
    console.error("Erreur webhook:", err);
    // Toujours 200 pour éviter que Telegram ne renvoie l'update en boucle
    return new Response("ok");
  }
}

export function GET(): Response {
  return new Response("Fish Voice Bot : en ligne ✅");
}
