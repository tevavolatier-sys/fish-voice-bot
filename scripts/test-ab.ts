// Tests sans réseau du test A/B (lib/ab.ts). Usage : npx tsx scripts/test-ab.ts
import { AB_WINDOW_MS, computeStats, groupFor } from "../lib/ab.js";

let fails = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "OK " : "KO "} ${label}`);
  if (!ok) fails++;
};

// Tirage stable et à peu près équilibré
const ids = Array.from({ length: 2000 }, (_, i) => String(1_000_000 + i * 7919));
const voice = ids.filter((id) => groupFor(id) === "voice").length;
check(`même fan → même groupe`, groupFor("42") === groupFor("42"));
check(`≈ 1/3 sur 2000 fans (${voice} vocal seul)`, voice > 560 && voice < 780);

// Statistiques
const now = Date.now();
const old = now - AB_WINDOW_MS - 1000;
const s = computeStats(
  [
    { g: "voice", at: old, s: true, r: old + 1000 },
    { g: "voice", at: old, s: true },
    { g: "voice", at: old }, // vocal pas parti : hors test
    { g: "voice", at: now - 1000, s: true }, // encore dans la fenêtre
    { g: "none", at: old, r: old + 5000, rev: 25, buys: 2 },
    { g: "none", at: old },
    { g: "none", at: old },
  ],
  now
);
check("avec vocal : 1 réponse sur 2 finis", s.voice.done === 2 && s.voice.replied === 1 && s.voice.rate === 0.5);
check("sans vocal : 1 réponse sur 3 finis", s.none.done === 3 && s.none.replied === 1);
check("CA : 25 $ sur 3 fans sans vocal", s.none.revenue === 25 && s.none.buyers === 1 && s.none.revPerFan === 8.33);
check("1 en attente, 1 hors test", s.voice.pending === 1 && s.excluded === 1);
check("pas de verdict avant 30 par groupe", s.significant === null);

const big = (g: "voice" | "none", n: number, replied: number) =>
  Array.from({ length: n }, (_, i) => ({ g, at: old, s: g === "voice" ? true : undefined, r: i < replied ? old + 1 : undefined }));
check("écart net → significatif", computeStats([...big("voice", 100, 60), ...big("none", 100, 30)], now).significant === true);
check("même taux → pas significatif", computeStats([...big("voice", 100, 40), ...big("none", 100, 42)], now).significant === false);

if (fails) {
  console.error(`${fails} test(s) en échec`);
  process.exit(1);
}
