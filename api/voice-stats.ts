// 🎙️ Compteur de vocaux par chatter (id Telegram), lu par le leaderboard de
// French Influence Pay. Protégé par la clé VOICE_STATS_KEY (en-tête x-stats-key).
//   GET /api/voice-stats?from=2026-10-06&to=2026-10-12 → vocaux sur la période
//   GET /api/voice-stats                                 → depuis le début
import { readVoiceCounts } from "../lib/redis.js";

export async function GET(req: Request): Promise<Response> {
  const key = process.env.VOICE_STATS_KEY?.trim() ?? "";
  if (key.length < 24 || req.headers.get("x-stats-key") !== key) {
    return new Response("not found", { status: 404 });
  }
  const u = new URL(req.url);
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const from = u.searchParams.get("from");
  const to = u.searchParams.get("to");
  if ((from && !day.test(from)) || (to && !day.test(to))) {
    return Response.json({ ok: false, error: "dates YYYY-MM-DD" }, { status: 400 });
  }
  const counts = await readVoiceCounts(from ?? undefined, to ?? undefined);
  return Response.json({ ok: true, from, to, counts });
}
