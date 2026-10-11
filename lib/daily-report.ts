// Rapport quotidien dans le groupe Telegram des chatters, avec @chattingtev tagué
// (demande de Teva, 11/10/2026). Envoyé par le cron Vercel (GET /api/daily-report).
// Contenu : PPV perso des dernières 24 h (prénom mis par le chatter / deviné /
// illisible, refaits, échecs), vocaux de bienvenue, test A/B, crédits OnlyFansAPI.
import { abStats } from "./ab.js";
import { readPpvAutoLog, sendAlert } from "./ppv-auto.js";
import { getWelcomeSettings, readWelcomeLog } from "./welcome.js";

const DAY = 24 * 3600_000;
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)} %` : "–");

/** Solde de crédits OnlyFansAPI (dans les métadonnées de n'importe quelle réponse) */
async function creditsBalance(): Promise<number | null> {
  try {
    const r = await fetch("https://app.onlyfansapi.com/api/webhooks", {
      headers: { Authorization: `Bearer ${process.env.ONLYFANS_API_KEY}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json()) as { _meta?: { _credits?: { balance?: number } } };
    const b = j._meta?._credits?.balance;
    return typeof b === "number" ? b : null;
  } catch {
    return null;
  }
}

export async function buildDailyReport(now = Date.now()): Promise<string> {
  const since = now - DAY;
  const [ppv, welcome, settings, balance] = await Promise.all([readPpvAutoLog(), readWelcomeLog(), getWelcomeSettings(), creditsBalance()]);
  const ab = settings.accountId ? await abStats(settings.accountId).catch(() => null) : null;

  const p = ppv.filter((l) => Date.parse(l.at) >= since);
  const done = p.filter((l) => l.status === "done" && !l.manual);
  const custom = done.filter((l) => l.source === "custom").length;
  const guessed = done.filter((l) => l.source === "guessed").length;
  const noname = p.filter((l) => l.status === "noname").length;
  const redo = p.filter((l) => l.manual).length;
  const failed = p.filter((l) => l.status === "error" && !l.manual).length;

  const w = welcome.filter((l) => Date.parse(l.at) >= since);
  const st = (l: (typeof w)[number]) => l.status ?? (l.ok ? "sent" : "error");
  const sent = w.filter((l) => st(l) === "sent").length;
  const late = w.filter((l) => st(l) === "late").length;
  const werr = w.filter((l) => st(l) === "error").length;
  const control = w.filter((l) => st(l) === "control").length;

  const lines = [
    `📊 Daily report — Sienna — ${new Date(now).toLocaleDateString("fr-FR", { timeZone: "Pacific/Tahiti" })} @chattingtev`,
    "",
    `🎬 Custom PPV (last 24 h): ${done.length} made`,
    `   • name set by chatter on OF: ${custom} (${pct(custom, done.length)})`,
    `   • name guessed from username: ${guessed} (${pct(guessed, done.length)})`,
    `   • name unreadable → no video: ${noname}`,
    `   • redone by hand: ${redo} · failed: ${failed}`,
    custom + guessed > 0 && custom / (custom + guessed) < 0.5
      ? "   ⚠️ Most names were guessed: remind chatters to rename fans on OnlyFans."
      : "",
    "",
    `🎙️ Welcome (last 24 h): ${sent} sent · ${late} too late · ${werr} failed · ${control} without voice (A/B)`,
  ];
  if (ab) {
    const g = (k: "voice" | "none" | "selfie") => {
      const s = ab[k];
      return `${k}: ${s.rate == null ? "–" : Math.round(s.rate * 100) + " %"} (${s.done} done)`;
    };
    lines.push(`🧪 A/B reply rate: ${g("voice")} · ${g("none")} · ${g("selfie")}` + (ab.significant ? " ✅ significant" : ""));
  }
  lines.push("", `💳 OnlyFansAPI credits left this month: ${balance == null ? "unknown" : balance.toLocaleString("en-US")} / 20,000`);
  return lines.filter((l) => l !== "").join("\n");
}

export async function sendDailyReport(): Promise<string> {
  const text = await buildDailyReport();
  await sendAlert(text);
  return text;
}
