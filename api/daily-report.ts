// Rapport quotidien (groupe Telegram des chatters, @chattingtev tagué).
// Lancé par le cron Vercel (vercel.json, 1 fois par jour) avec « Authorization: Bearer <CRON_SECRET> ».
// Test à la main : GET /api/daily-report?key=<CRON_SECRET>
import { sendDailyReport } from "../lib/daily-report.js";

export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET ?? "";
  const auth = req.headers.get("authorization") ?? "";
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!secret || (auth !== `Bearer ${secret}` && key !== secret)) return new Response("non autorisé", { status: 401 });
  const text = await sendDailyReport();
  return Response.json({ ok: true, text });
}
