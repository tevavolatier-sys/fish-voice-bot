// Webhooks OnlyFansAPI : subscriptions.new (vocal de bienvenue) et messages.received (test A/B).
// Déclaré/mis à jour automatiquement par l'action « webhookSetup » de api/welcome.ts
// (API OnlyFansAPI /webhooks), avec le secret ONLYFANS_WEBHOOK_SECRET.
// Une 401 répétée (mauvais secret) met le webhook en pause après 20 échecs (événements perdus).
import { createHmac, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { recordReply } from "../lib/ab.js";
import { getRedis } from "../lib/redis.js";
import { getWelcomeSettings, handleNewSub } from "../lib/welcome.js";

export const maxDuration = 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/**
 * Signature HMAC SHA-256 du corps brut, cherchée dans les en-têtes : hex ou
 * base64, avec ou sans préfixe « sha256= » (la doc OnlyFansAPI ne précise pas
 * le format ; la 1re livraison réelle le confirmera dans leur tableau de bord).
 */
function signed(req: Request, raw: string, secret: string): boolean {
  const wants = ["hex", "base64"].map((enc) =>
    createHmac("sha256", secret).update(raw).digest(enc as "hex" | "base64")
  );
  for (const [, v] of req.headers) {
    const got = v.trim().replace(/^sha256=/i, "");
    for (const want of wants) {
      if (got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want))) return true;
    }
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
    // Heure de l'abonnement : celle du payload si elle existe, sinon la réception du webhook
    const p = body?.payload ?? {};
    // Doc OnlyFansAPI : la date de l'événement est payload.createdAt (ISO 8601) ;
    // secours : user.subscribedOnData.subscribeAt (abonnement du fan à la créatrice)
    const rawAt = p?.createdAt ?? p?.user?.subscribedOnData?.subscribeAt;
    const parsed = rawAt ? Date.parse(String(rawAt)) : NaN;
    const age = Date.now() - parsed;
    const subscribedAt = Number.isFinite(parsed) && age > -60_000 && age < 10 * 60_000 ? parsed : Date.now();
    if (fan.id) waitUntil(handleNewSub(str(body?.account_id), fan.id, fan.name, fan.username, { subscribedAt }));
  } else if (body?.event === "messages.received") {
    // Test A/B : un fan du test a écrit → on note sa première réponse (si dans les 48 h)
    const fan = fanOf(body?.payload ?? {});
    const accountId = str(body?.account_id);
    if (fan.id && accountId) {
      waitUntil(
        getWelcomeSettings().then((s) => (s.accountId === accountId ? recordReply(accountId, fan.id) : false))
      );
    }
  }
  // Répondre vite : le vocal est généré et envoyé après la réponse
  return Response.json({ ok: true });
}
