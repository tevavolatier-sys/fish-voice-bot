// Endpoint interne pour l'outil local « vocaux en masse » : l'API Gemini
// n'est pas accessible depuis la Polynésie, donc l'enrichissement passe par
// ici (Vercel US). Protégé par le secret du webhook.
import { enrichWithEmotionTags } from "../lib/enrich.js";

export const maxDuration = 30;

export async function POST(req: Request): Promise<Response> {
  const key = req.headers.get("x-batch-key");
  if (!key || key !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as {
    text?: string;
    level?: number;
    variety?: boolean;
  } | null;
  const text = String(body?.text ?? "").trim();
  if (!text) {
    return Response.json({ ok: false, error: "text missing" }, { status: 400 });
  }
  const taggedText = await enrichWithEmotionTags(
    text,
    Number(body?.level ?? 1),
    Boolean(body?.variety)
  );
  return Response.json({ ok: true, taggedText });
}
