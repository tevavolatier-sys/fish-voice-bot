// Rapport du test A/B et du vrai reply rate, lu directement dans le Redis de production.
// Usage : npx vercel env pull --environment=production .env.prod.local && npx tsx scripts/ab-report.ts
import { readFileSync } from "node:fs";
import { AB_WINDOW_MS, computeStats } from "../lib/ab.js";

for (const line of readFileSync(".env.prod.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"\r]*)"?/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { getRedis } = await import("../lib/redis.js");
const { getWelcomeSettings, readWelcomeLog } = await import("../lib/welcome.js");

const r = getRedis();
const s = await getWelcomeSettings();
const all = (await r.hgetall<Record<string, string | object>>(`welcome:ab:${s.accountId}`)) ?? {};
const entries = Object.values(all).map((v) => (typeof v === "string" ? JSON.parse(v) : v));
const st = computeStats(entries);
const pct = (x: number | null) => (x == null ? "–" : Math.round(x * 100) + " %");
const log = await readWelcomeLog();
const n = (k: string) => log.filter((l) => (l.status ?? (l.ok ? "sent" : "error")) === k).length;

console.log(`Compte ${s.accountId} · vocal ${s.enabled ? "ACTIF" : "arrêté"} · test A/B ${s.abEnabled ? "EN COURS" : "arrêté"}`);
console.log(`Journal (200 derniers) : ${n("sent")} envoyés · ${n("control")} sans vocal (test) · ${n("late")} trop tard · ${n("error")} échecs`);
console.log(`Fans dans le test : ${entries.length} (depuis ${st.since ? new Date(st.since).toLocaleString("fr-FR") : "–"}), fenêtre ${AB_WINDOW_MS / 3600_000} h`);
for (const [label, g] of [["Avec vocal", st.voice], ["Sans vocal", st.none]] as const) {
  console.log(`  ${label.padEnd(11)} terminés ${g.done} · répondu ${g.replied} (${pct(g.rate)}) · <1 h ${g.within1h} · <24 h ${g.within24h} · en attente ${g.pending} (${g.pendingReplied} déjà répondu)`);
}
console.log(`  Reply rate global : ${pct(st.all.rate)} (${st.all.replied} / ${st.all.done} terminés) · hors test ${st.excluded}`);
console.log(`  Écart ${st.diffPts == null ? "–" : Math.round(st.diffPts) + " pts"} · confiance ${pct(st.confidence)} · verdict ${st.significant == null ? "trop tôt" : st.significant ? "FIABLE" : "pas d'écart"} · encore ~${st.needPerGroup}/groupe`);
