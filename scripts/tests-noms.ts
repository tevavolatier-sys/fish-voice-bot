// Test A/B des prénoms dans le vocal de bienvenue (Sienna, Fish Audio Drama 3) :
// chaque prénom en version A (écrit tel quel) et B (réécrit en phonétique française).
// Sortie : tests_noms/01A.mp3, 01B.mp3… puis la page d'écoute à l'aveugle tests_noms/ecoute.html
// Lancer : FISH_API_KEY=… npx tsx scripts/tests-noms.ts
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SIENNA = "aa13d26cfc6e41f1b1f7a02bf5baa606";
// La doc officielle (docs.fish.audio) liste le modèle « drama-3 » (pas « drama-3-preview »)
const MODEL = process.env.FISH_MODEL_TEST || "drama-3";
const OUT = "tests_noms";

const NAMES: [string, string][] = [
  ["Mike", "Maïk"],
  ["Ryan", "Raïane"],
  ["James", "Djèïmz"],
  ["Josh", "Djosh"],
  ["Steve", "Stiv"],
  ["Brian", "Braïane"],
  ["Kyle", "Kaïl"],
  ["Ethan", "Iiseune"],
  ["Matthew", "Matiou"],
  ["Dark Wolf", "Dark Woulf"],
];

const line = (name: string) =>
  `[Young woman, relaxed on the couch, close to the mic, reading his name off her screen for the first time, a small smile] Coucou ${name}… ` +
  `[a little warmer, smiling, gently cheerful, a light lift on the word page] Bienvenue sur ma page !`;

async function tts(text: string): Promise<Buffer> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.FISH_API_KEY}`, "Content-Type": "application/json", model: MODEL },
      body: JSON.stringify({ text, reference_id: SIENNA, format: "mp3", mp3_bitrate: 128 }),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const body = await res.text();
    if (res.status < 500 && res.status !== 429) throw new Error(`Fish ${res.status} : ${body.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  throw new Error("Fish Audio ne répond pas");
}

if (!process.env.FISH_API_KEY) throw new Error("FISH_API_KEY manquante");
mkdirSync(OUT, { recursive: true });
const files: { file: string; num: string; version: "A" | "B"; name: string }[] = [];
for (const [i, [a, b]] of NAMES.entries()) {
  const num = String(i + 1).padStart(2, "0");
  for (const [version, name] of [["A", a], ["B", b]] as const) {
    const file = `${num}${version}.mp3`;
    files.push({ file, num, version, name });
    if (existsSync(join(OUT, file))) { console.log(file, "déjà là"); continue; }
    writeFileSync(join(OUT, file), await tts(line(name)));
    console.log(file, "←", name);
  }
}

// Page d'écoute à l'aveugle : ordre aléatoire, notes 1-5, résultats A vs B par prénom
const meta = files.map((f) => ({ file: f.file, num: f.num, version: f.version, name: f.name, pair: NAMES[Number(f.num) - 1][0] }));
const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Écoute à l'aveugle</title><style>
:root{--bg:#f6f6f4;--card:#fff;--ink:#1b1b1a;--mute:#6d6d68;--line:#e3e3de;--acc:#c2416b;--ok:#1f8a54}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecece8;--mute:#9a9a93;--line:#30302d;--acc:#ec6f97;--ok:#4cc286}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:24px 16px 60px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}audio{flex:1;min-width:220px}
.stars button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;width:36px;height:36px;cursor:pointer}
.stars button.on{background:var(--acc);border-color:var(--acc);color:#fff}
table{width:100%;border-collapse:collapse}td,th{padding:6px;border-bottom:1px solid var(--line);text-align:left}
.win{color:var(--ok);font-weight:700}.hint{color:var(--mute);font-size:13px}
button.main{font:inherit;background:var(--acc);border:0;color:#fff;border-radius:8px;padding:10px 16px;cursor:pointer}
</style></head><body><main>
<h1>Écoute à l'aveugle</h1>
<p class="hint">20 vocaux dans le désordre. Note chacun de 1 (bizarre) à 5 (naturel). Les notes sont gardées dans ce navigateur.</p>
<div id="list"></div>
<button class="main" id="show">Voir les résultats</button> <span class="hint" id="left"></span>
<div id="res"></div>
</main><script>
const META = ${JSON.stringify(meta)};
let order, notes = {};
try { order = JSON.parse(localStorage.getItem("tn4-order")); notes = JSON.parse(localStorage.getItem("tn4-notes")) || {}; } catch {}
if (!Array.isArray(order) || order.length !== META.length) {
  order = META.map((_, i) => i).sort(() => Math.random() - 0.5);
  try { localStorage.setItem("tn4-order", JSON.stringify(order)); } catch {}
}
const save = () => { try { localStorage.setItem("tn4-notes", JSON.stringify(notes)); } catch {} };
const list = document.getElementById("list");
order.forEach((idx, pos) => {
  const m = META[idx];
  const c = document.createElement("div"); c.className = "card";
  c.innerHTML = '<div class="row"><b>Vocal ' + (pos + 1) + '</b><audio controls preload="none" src="' + m.file + '"></audio></div><div class="row stars" style="margin-top:8px">' +
    [1,2,3,4,5].map((n) => '<button data-n="' + n + '">' + n + '</button>').join("") + '</div>';
  const paint = () => c.querySelectorAll("[data-n]").forEach((b) => b.classList.toggle("on", Number(b.dataset.n) === notes[m.file]));
  c.querySelectorAll("[data-n]").forEach((b) => b.onclick = () => { notes[m.file] = Number(b.dataset.n); save(); paint(); left(); });
  paint(); list.appendChild(c);
});
function left() { const n = META.filter((m) => notes[m.file]).length; document.getElementById("left").textContent = n + " / " + META.length + " notés"; }
left();
document.getElementById("show").onclick = () => {
  const nums = [...new Set(META.map((m) => m.num))];
  let winsA = 0, winsB = 0, ties = 0;
  const rows = nums.map((num) => {
    const a = META.find((m) => m.num === num && m.version === "A"), b = META.find((m) => m.num === num && m.version === "B");
    const na = notes[a.file], nb = notes[b.file];
    let w = "–";
    if (na && nb) { if (na > nb) { w = "A"; winsA++; } else if (nb > na) { w = "B"; winsB++; } else { w = "égalité"; ties++; } }
    return "<tr><td>" + a.pair + "</td><td" + (w === "A" ? ' class="win"' : "") + ">A « " + a.name + " » : " + (na ?? "–") + "</td><td" + (w === "B" ? ' class="win"' : "") + ">B « " + b.name + " » : " + (nb ?? "–") + "</td><td><b>" + w + "</b></td></tr>";
  }).join("");
  const verdict = winsA >= 7 ? "A gagne sur " + winsA + " prénoms : on abandonne la réécriture phonétique." : "A ne gagne que sur " + winsA + " prénoms (B : " + winsB + ", égalités : " + ties + ") : on garde la réécriture phonétique.";
  document.getElementById("res").innerHTML = '<div class="card" style="margin-top:14px"><h2 style="margin-top:0">Résultats</h2><table><tr><th>Prénom</th><th>A (tel quel)</th><th>B (phonétique)</th><th>Gagnant</th></tr>' + rows + '</table><p><b>' + verdict + '</b></p></div>';
};
</script></body></html>`;
writeFileSync(join(OUT, "ecoute.html"), html);
console.log("Page d'écoute :", join(OUT, "ecoute.html"));
