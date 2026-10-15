// Rapport quotidien dans le groupe Telegram des chatters, avec @chattingtev tagué
// (demande de Teva, 11/10/2026). Envoyé par le cron Vercel (GET /api/daily-report).
// Contenu : PPV perso des dernières 24 h (prénom mis par le chatter / deviné /
// illisible, refaits, échecs), vocaux de bienvenue, test A/B, crédits OnlyFansAPI.
// Multi-comptes (15/10/2026) : un bloc par compte actif (Sienna toujours, Lena/Jade
// seulement si leur bienvenue ou leur PPV auto est activé), crédits globaux à la fin.
import { ACCOUNTS, type OfAccount } from "./accounts.js";
import { abStats } from "./ab.js";
import { abImage, sendAbImageToAdmin } from "./ab-image.js";
import { creditsBalanceLive, creditsToday, getCreditsCap } from "./onlyfans.js";
import { getPpvAutoSettings, readPpvAutoLog, sendAlert } from "./ppv-auto.js";
import { getWelcomeSettings, readWelcomeLog } from "./welcome.js";

const DAY = 24 * 3600_000;
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)} %` : "–");

/** Comptes du rapport : Sienna toujours, les autres si un automatisme est activé */
export async function reportAccounts(): Promise<OfAccount[]> {
  const out: OfAccount[] = [];
  for (const a of ACCOUNTS) {
    if (a.legacy) { out.push(a); continue; }
    const [w, p] = await Promise.all([getWelcomeSettings(a), getPpvAutoSettings(a)]);
    if (w.enabled || p.enabled) out.push(a);
  }
  return out;
}

async function accountSection(a: OfAccount, now: number, header: string): Promise<string[]> {
  const since = now - DAY;
  const [ppv, welcome, settings] = await Promise.all([readPpvAutoLog(a), readWelcomeLog(a), getWelcomeSettings(a)]);
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
    header,
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
  return lines;
}

export async function buildDailyReport(now = Date.now()): Promise<string> {
  const date = new Date(now).toLocaleDateString("fr-FR", { timeZone: "Pacific/Tahiti" });
  const accounts = await reportAccounts();
  const [balance, usedToday, cap] = await Promise.all([creditsBalanceLive(), creditsToday().catch(() => 0), getCreditsCap().catch(() => 0)]);
  const lines: string[] = [];
  for (const [i, a] of accounts.entries()) {
    // 1er bloc : en-tête d'origine (avec @chattingtev) ; les suivants indiquent le compte
    const header = i === 0
      ? `📊 Daily report — ${a.modelName}${a.legacy ? "" : ` (@${a.handle})`} — ${date} @chattingtev`
      : `📊 ${a.modelName} (@${a.handle})`;
    if (i > 0) lines.push("", "────────");
    lines.push(...(await accountSection(a, now, header)));
  }
  lines.push(
    "",
    `💳 OnlyFansAPI credits left this month: ${balance == null ? "unknown" : balance.toLocaleString("en-US")} / 20,000`,
    `   • used today (all accounts): ${usedToday.toLocaleString("en-US")} / daily cap ${cap.toLocaleString("en-US")}`
  );
  return lines.filter((l) => l !== "").join("\n");
}

export async function sendDailyReport(): Promise<string> {
  const text = await buildDailyReport();
  await sendAlert(text);
  // Image du test A/B/C en privé à Teva, par le bot « French Influence Voice » (un par compte suivi)
  for (const a of await reportAccounts()) {
    const s = await getWelcomeSettings(a);
    if (!s.accountId || (!a.legacy && !s.abEnabled)) continue;
    const ab = await abStats(s.accountId);
    await sendAbImageToAdmin(await abImage(ab), `📊 Test A/B/C${a.legacy ? "" : ` — ${a.modelName}`} — reply rate (daily)`);
  }
  return text;
}
