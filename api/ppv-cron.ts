// Nettoyage du vault OnlyFans (dossiers « PPV1 - Prénom » après 30 min, fichiers après 24 h).
// Appelé par un pinger externe (cron-job.org…) toutes les 5 min : GET /api/ppv-cron?key=<ONLYFANS_WEBHOOK_SECRET>
// Le même nettoyage tourne aussi à chaque webhook OnlyFans reçu.
import { pendingCleanups, runCleanup } from "../lib/ppv-auto.js";

export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!key || key !== process.env.ONLYFANS_WEBHOOK_SECRET) return new Response("non autorisé", { status: 401 });
  const r = await runCleanup();
  return Response.json({ ok: true, ...r, pending: await pendingCleanups() });
}
