// Webhook Telegram du bot d'alerte PPV (@AUTOCUSTOMZZZBOT), demande de Teva du 12/10/2026 :
// bouton « ✏️ Wrong name? Redo » sous chaque alerte → le bot demande le bon prénom
// (réponse forcée) → le chatter répond « Kevin » → nouvelles vidéos + nouveau dossier
// dans le vault + nouvelle alerte. Déclaré chez Telegram par l'action « ppvBotSetup ».
import { waitUntil } from "@vercel/functions";
import { cleanFanName } from "../lib/ppv.js";
import { getContext, producePpvForFan } from "../lib/ppv-auto.js";
import { getRedis } from "../lib/redis.js";
import { accountByKey, ACCOUNTS } from "../lib/accounts.js";
import { accountIdOf } from "../lib/welcome.js";

export const maxDuration = 300;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function tg(method: string, body: Record<string, unknown>): Promise<Any> {
  const r = await fetch(`https://api.telegram.org/bot${process.env.PPV_ALERT_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return r.json().catch(() => ({}));
}

const ASK = (chat: number | string, msg: number) => `ppvbot:ask:${chat}:${msg}`;

export async function POST(req: Request): Promise<Response> {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== process.env.CRON_SECRET) {
    return new Response("non autorisé", { status: 401 });
  }
  const u = (await req.json().catch(() => ({}))) as Any;
  console.log("ppv-bot update:", JSON.stringify({ cb: u.callback_query?.data, chat: (u.message ?? u.callback_query?.message)?.chat?.id, text: u.message?.text?.slice(0, 40), replyTo: u.message?.reply_to_message?.message_id, thread: u.message?.message_thread_id }));

  // 1) Clic sur le bouton → on demande le prénom en réponse forcée
  const cb = u.callback_query;
  // « redo:<fan> » (Sienna) ou « redo:<compte>:<fan> » (Lena, Jade)
  const redo = cb ? /^redo:(?:([a-z]+):)?(\d+)$/.exec(String(cb.data ?? "")) : null;
  if (cb && redo && (!redo[1] || ACCOUNTS.some((x) => x.key === redo[1]))) {
    const acc = accountByKey(redo[1]);
    const fanId = redo[2];
    const chat = cb.message?.chat?.id;
    await tg("answerCallbackQuery", { callback_query_id: cb.id });
    const who = cb.from?.username ? `@${cb.from.username}` : cb.from?.first_name ?? "";
    const ctx = await getContext(fanId, acc);
    const sent = await tg("sendMessage", {
      chat_id: chat,
      text: `✏️ ${who} reply to this message with the right first name for ${ctx?.display || ctx?.username || `fan ${fanId}`} (just the name, e.g. Kevin):`,
      reply_to_message_id: cb.message?.message_id,
      reply_markup: { force_reply: true, selective: true, input_field_placeholder: "First name" },
    });
    const msgId = sent?.result?.message_id;
    console.log("ppv-bot ask sent:", JSON.stringify(sent).slice(0, 300));
    if (chat && msgId) await getRedis().set(ASK(chat, msgId), acc.legacy ? fanId : `${acc.key}:${fanId}`, { ex: 24 * 3600 });
    return Response.json({ ok: true });
  }

  // 2) Réponse avec le prénom → nouvelles vidéos
  const m = u.message;
  const replyTo = m?.reply_to_message?.message_id;
  if (m?.text && replyTo) {
    const raw = await getRedis().get<string | number>(ASK(m.chat.id, replyTo));
    console.log("ppv-bot reply lookup:", ASK(m.chat.id, replyTo), "→", raw);
    if (raw == null) return Response.json({ ok: true });
    const [k, f] = String(raw).includes(":") ? String(raw).split(":") : ["", String(raw)];
    const acc = accountByKey(k);
    const fanId = f;
    const name = cleanFanName(String(m.text).trim().split(/\s+/)[0] ?? "");
    if (!name) {
      await tg("sendMessage", { chat_id: m.chat.id, reply_to_message_id: m.message_id, text: "❌ That doesn't look like a first name (letters only, 2 to 20). Tap the button again." });
      return Response.json({ ok: true });
    }
    await getRedis().del(ASK(m.chat.id, replyTo));
    const ctx = (await getContext(fanId, acc)) ?? {
      accountId: await accountIdOf(acc), fanId, chatId: fanId, messageId: "", display: "", name: "", username: "", amount: 0, at: Date.now(),
    };
    await tg("sendMessage", { chat_id: m.chat.id, reply_to_message_id: m.message_id, text: `⏳ Making ${name}'s videos again… (about 1 min, a new alert will follow)` });
    waitUntil(producePpvForFan({ ...ctx, at: Date.now() }, name, true).then(() => undefined).catch((e) => console.error("redo:", e)));
    return Response.json({ ok: true });
  }
  return Response.json({ ok: true });
}
