// Webhooks OnlyFansAPI : subscriptions.new (vocal de bienvenue), messages.received et transactions.new (test A/B).
// Déclaré/mis à jour automatiquement par l'action « webhookSetup » de api/welcome.ts
// (API OnlyFansAPI /webhooks), avec le secret ONLYFANS_WEBHOOK_SECRET.
// Multi-comptes (Sienna, Lena, Jade : lib/accounts.ts) : le compte est celui du payload (account_id),
// ou à défaut le paramètre ?acct=<acct_… ou lena/jade> de l'URL du webhook.
// Une 401 répétée (mauvais secret) met le webhook en pause après 20 échecs (événements perdus).
import { createHmac, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { recordReply, recordRevenue } from "../lib/ab.js";
import { getRedis } from "../lib/redis.js";
import { handlePpvUnlocked, runCleanup } from "../lib/ppv-auto.js";
import { trackSent } from "../lib/ppv-track.js";
import { accountFromParam } from "../lib/accounts.js";
import { getWelcomeSettings, handleNewSub, resolveAccount } from "../lib/welcome.js";

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

  // Compte : account_id du payload, sinon ?acct= dans l'URL
  const acctParam = accountFromParam(new URL(req.url).searchParams.get("acct"));
  const acctOf = () => str(body?.account_id) || acctParam?.acct || "";
  /** Le fan appartient-il au test de ce compte ? (compte connu et réglages au même acct_) */
  const sameAccount = async (accountId: string) => {
    const a = await resolveAccount(accountId);
    return a ? (await getWelcomeSettings(a)).accountId === accountId : false;
  };

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
    if (fan.id) waitUntil(handleNewSub(acctOf(), fan.id, fan.name, fan.username, { subscribedAt }));
  } else if (body?.event === "transactions.new") {
    // Test A/B : CA du fan (tip, PPV, extension…) dans sa fenêtre
    const p = body?.payload ?? {};
    const fan = fanOf(p);
    const accountId = acctOf();
    const amount = Number(p?.amount?.gross ?? p?.amount_gross ?? p?.gross ?? p?.amount ?? p?.price ?? 0) || 0;
    // Les abonnements (nouveaux, renouvellements) ne comptent pas dans le CA du test : même base que le rattrapage OF
    const kind = String(p?.type ?? p?.transactionType ?? p?.description ?? "").toLowerCase();
    if (fan.id && accountId && amount > 0 && !/subscri|abonn/.test(kind)) {
      waitUntil(sameAccount(accountId).then((ok) => (ok ? recordRevenue(accountId, fan.id, amount) : false)));
    }
  } else if (body?.event === "messages.ppv.unlocked") {
    // PPV perso automatique : achat du PPV de bienvenue → preview + PPV 1 avec le prénom
    const p = body?.payload ?? {};
    const f = p?.fan ?? {};
    const accountId = acctOf();
    const fanId = str(f.id ?? p?.chat_id);
    if (accountId && fanId) {
      const at = Date.parse(String(p?.createdAt ?? "")) || Date.now();
      waitUntil(handlePpvUnlocked({
        accountId, fanId, chatId: str(p?.chat_id) || fanId, messageId: str(p?.message_id),
        display: str(f.display_name) || str(f.name), name: str(f.name), username: str(f.username),
        amount: Number(p?.amountGross ?? 0) || 0, at,
      }));
    }
  } else if (body?.event === "messages.sent") {
    // Unlock rate des PPV perso : le chatter a-t-il envoyé le PPV qui contient les vidéos du bot ?
    const p = body?.payload ?? {};
    const accountId = acctOf();
    const fanId = str(p?.toUser?.id ?? p?.chat_id ?? p?.withUser?.id);
    const media = (Array.isArray(p?.media) ? p.media : []).map((m: Any) => str(m?.id)).filter(Boolean);
    const price = Number(p?.price ?? 0) || 0;
    if (accountId && fanId && media.length && price > 0) {
      waitUntil(trackSent(accountId, fanId, str(p?.id), media, price).catch((e) => console.error("suivi envoi:", e)));
    }
  } else if (body?.event === "messages.received") {
    // Test A/B : un fan du test a écrit → on note sa première réponse (si dans les 72 h)
    const fan = fanOf(body?.payload ?? {});
    const accountId = acctOf();
    if (fan.id && accountId) {
      waitUntil(sameAccount(accountId).then((ok) => (ok ? recordReply(accountId, fan.id) : false)));
    }
  }
  // Nettoyage du vault (dossiers PPV perso expirés) au passage, sans bloquer la réponse
  waitUntil(runCleanup().catch((e) => console.error("nettoyage:", e)));
  // Répondre vite : le vocal est généré et envoyé après la réponse
  return Response.json({ ok: true });
}
