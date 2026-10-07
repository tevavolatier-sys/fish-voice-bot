// Webhooks OnlyFansAPI. À déclarer dans la console OnlyFansAPI (Webhooks → Add Webhook)
// avec https://<projet>.vercel.app/api/of-webhook, événement « subscriptions.new »,
// et le même secret que ONLYFANS_WEBHOOK_SECRET.
import { createHmac, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { getRedis } from "../lib/redis.js";
import { handleNewSub } from "../lib/welcome.js";

export const maxDuration = 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Signature HMAC SHA-256 (hex) du corps brut, cherchée dans les en-têtes */
function signed(req: Request, raw: string, secret: string): boolean {
  const want = createHmac("sha256", secret).update(raw).digest("hex");
  for (const [, v] of req.headers) {
    const got = v.trim().replace(/^sha256=/i, "");
    if (got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want))) return true;
  }
  return false;
}

const str = (v: unknown) => (v == null || v === "" ? "" : String(v));

/** Le fan concerné, où qu'il soit rangé dans le payload */
function fanOf(p: Any): { id: string; name: string; username: string } {
  const u = p?.user ?? p?.subscriber ?? p?.fan ?? p?.fromUser ?? {};
  return {
    id: str(u.id ?? p?.user_id ?? p?.fan_id ?? p?.userId ?? p?.fanId),
    name: str(u.name ?? u.displayName ?? p?.name),
    username: str(u.username ?? p?.username),
  };
}

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();
  const secret = process.env.ONLYFANS_WEBHOOK_SECRET;
  if (!secret || !signed(req, raw, secret)) {
    return new Response("signature invalide", { status: 401 });
  }
  let body: Any;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("JSON attendu", { status: 400 });
  }

  // Le même webhook peut être renvoyé : on ne le traite qu'une fois
  const key = req.headers.get("x-ofapi-idempotency-key");
  if (key) {
    const fresh = await getRedis().set(`ofhook:${key}`, "1", { nx: true, ex: 7 * 24 * 3600 });
    if (fresh !== "OK") return Response.json({ ok: true, duplicate: true });
  }

  if (body?.event === "subscriptions.new") {
    const fan = fanOf(body?.payload ?? {});
    if (fan.id) waitUntil(handleNewSub(str(body?.account_id), fan.id, fan.name, fan.username));
  }
  // Répondre vite : le vocal est généré et envoyé après la réponse
  return Response.json({ ok: true });
}
