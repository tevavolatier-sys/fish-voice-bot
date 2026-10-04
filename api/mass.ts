// 📣 BOT MASS MESSAGES (bot Telegram séparé, token MASS_BOT_TOKEN) : textes
// de mass message PPV OnlyFans en français / anglais, suggestifs mais jamais
// explicites, tout réglable. Même hébergement, même Redis et même clé Gemini
// que le Voice Bot.
import { Bot, Context, InlineKeyboard, webhookCallback } from "grammy";
import { waitUntil } from "@vercel/functions";
import { randomUUID } from "node:crypto";
import { isAllowed } from "../lib/config.js";
import {
  applyMass,
  generateMass,
  massKeyboard,
  massPanelText,
  normalizeMass,
  translateMass,
  type MassSettings,
} from "../lib/mass.js";
import {
  addMassFav,
  getMassFavs,
  getMassRaw,
  getMassText,
  saveMass,
  saveMassText,
} from "../lib/redis.js";

export const maxDuration = 60;

const newId = () => randomUUID().replace(/-/g, "").slice(0, 16);
const loadMass = async (uid: number) => normalizeMass(await getMassRaw(uid).catch(() => null));
const panel = (ctx: Context, s: MassSettings, note?: string) =>
  ctx.reply((note ? `${note}\n\n` : "") + massPanelText(s), { reply_markup: massKeyboard(s) });

function createBot(): Bot {
  const bot = new Bot(process.env.MASS_BOT_TOKEN!);

  // Réservé à l'équipe : mêmes accès que le Voice Bot (utilisateurs ou groupes autorisés)
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id || !isAllowed(id, ctx.chat?.id)) {
      if (ctx.chat?.type === "private" && id) {
        await ctx.reply(`⛔ Not allowed. Send this id to the admin: ${id}`).catch(() => {});
      }
      return;
    }
    await next();
  });

  bot.command(["start", "mass", "help"], async (ctx) => panel(ctx, await loadMass(ctx.from!.id)));

  // Réglages en texte libre
  for (const [cmd, field, label, max] of [
    ["info", "content", "📦 Content", 400],
    ["theme", "customTheme", "🎭 Custom theme", 200],
    ["girl", "girl", "👩 Girl's name", 30],
  ] as const) {
    bot.command(cmd, async (ctx) => {
      const value = String(ctx.match ?? "").trim().slice(0, max);
      const s = await loadMass(ctx.from!.id);
      const next = normalizeMass({ ...s, [field]: value, ...(cmd === "theme" && value ? { theme: "custom" } : {}) });
      await saveMass(ctx.from!.id, next);
      await panel(ctx, next, value ? `✅ ${label} saved.` : `✅ ${label} cleared.`);
    });
  }

  bot.command("fav", async (ctx) => {
    const favs = await getMassFavs().catch(() => []);
    if (!favs.length) {
      await ctx.reply("⭐ No saved text yet: tap ⭐ Save under a text you like.");
      return;
    }
    for (const t of favs.slice(0, 10)) await ctx.reply(t);
  });

  bot.callbackQuery(/^mass:([a-z]+)(?::([ud]))?$/, async (ctx) => {
    const uid = ctx.from.id;
    const [action, arg] = [ctx.match[1], ctx.match[2]];
    if (action === "noop") {
      await ctx.answerCallbackQuery();
      return;
    }
    const s = await loadMass(uid);
    if (action === "panel") {
      await ctx.answerCallbackQuery();
      await panel(ctx, s);
      return;
    }
    if (action !== "go") {
      const next = applyMass(s, action, arg);
      await saveMass(uid, next);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(massPanelText(next), { reply_markup: massKeyboard(next) }).catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery({ text: "✨ Writing…" });
    waitUntil(
      (async () => {
        try {
          await ctx.replyWithChatAction("typing").catch(() => {});
          const texts = await generateMass(s);
          if (!texts.length) {
            await ctx.reply("❌ Nothing usable this time — tap ✨ again.");
            return;
          }
          for (const t of texts) {
            const id = newId();
            await saveMassText(id, t);
            await ctx.reply(t, {
              reply_markup: new InlineKeyboard()
                .text("⭐ Save", `fav:${id}`)
                .text(s.lang === "fr" ? "🇬🇧 English" : "🇫🇷 Français", `tr:${id}:${s.lang === "fr" ? "en" : "fr"}`),
            });
          }
          await ctx.reply("👆 Copy the one you like into Infloww ({name} = the fan's first name).", {
            reply_markup: new InlineKeyboard().text("✨ More", "mass:go").text("⚙️ Settings", "mass:panel"),
          });
        } catch (err) {
          console.error("Mass échoué:", err);
          await ctx.reply("❌ Couldn't write the texts — try again in a moment.").catch(() => {});
        }
      })()
    );
  });

  bot.callbackQuery(/^fav:([a-z0-9]{6,32})$/, async (ctx) => {
    const t = await getMassText(ctx.match[1]).catch(() => null);
    if (!t) {
      await ctx.answerCallbackQuery({ text: "Too old." });
      return;
    }
    await addMassFav(t);
    await ctx.answerCallbackQuery({ text: "⭐ Saved — /fav to see them" });
  });

  bot.callbackQuery(/^tr:([a-z0-9]{6,32}):(fr|en)$/, async (ctx) => {
    const t = await getMassText(ctx.match[1]).catch(() => null);
    if (!t) {
      await ctx.answerCallbackQuery({ text: "Too old." });
      return;
    }
    await ctx.answerCallbackQuery({ text: "🌐 Translating…" });
    waitUntil(
      (async () => {
        const out = await translateMass(t, ctx.match[2] as "fr" | "en").catch(() => null);
        if (!out) {
          await ctx.reply("❌ Couldn't translate — try again.").catch(() => {});
          return;
        }
        const id = newId();
        await saveMassText(id, out);
        await ctx.reply(out, { reply_markup: new InlineKeyboard().text("⭐ Save", `fav:${id}`) });
      })()
    );
  });

  return bot;
}

let handle: ((req: Request) => Promise<Response>) | null = null;

export async function POST(req: Request): Promise<Response> {
  try {
    if (!handle) {
      handle = webhookCallback(createBot(), "std/http", {
        secretToken: process.env.MASS_WEBHOOK_SECRET,
      });
    }
    return await handle(req);
  } catch (err) {
    console.error("Erreur bot mass:", err);
    return new Response("ok");
  }
}

export async function GET(): Promise<Response> {
  return Response.json({
    status: "Mass bot en ligne ✅",
    token: Boolean(process.env.MASS_BOT_TOKEN),
    gemini: Boolean(process.env.GEMINI_API_KEY),
  });
}
