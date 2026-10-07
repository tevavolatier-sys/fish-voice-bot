// Interface web du vocal de bienvenue (Sienna) : https://<projet>.vercel.app/api/welcome
// GET  → la page (aucune donnée dedans)
// POST → actions (mot de passe WELCOME_ADMIN_PASSWORD seulement s'il est défini)
import { timingSafeEqual } from "node:crypto";
import { requestsThisMonth } from "../lib/onlyfans.js";
import { getRedis } from "../lib/redis.js";
import {
  MONTHLY_LIMIT,
  uploadTake,
  STOP_AT,
  TAKE_COUNT,
  buildWelcomeVoice,
  chooseTake,
  generateTakes,
  getChosenTake,
  getWelcomeSettings,
  handleNewSub,
  readWelcomeLog,
  saveWelcomeSettings,
  type TakeKind,
  type WelcomeSettings,
} from "../lib/welcome.js";

export const maxDuration = 60;

function authorized(req: Request): boolean {
  const want = process.env.WELCOME_ADMIN_PASSWORD ?? "";
  const got = req.headers.get("x-admin-key") ?? "";
  if (!want) return true; // pas de mot de passe voulu (choix de Teva, 07/10/2026)
  return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

const kindOf = (v: unknown): TakeKind => (v === "fallback" ? "fallback" : "fixed");

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) return Response.json({ ok: false, error: "Mot de passe incorrect." }, { status: 401 });
  const a = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    switch (a.action) {
      case "load": {
        const [settings, fixed, fallback, used, log] = await Promise.all([
          getWelcomeSettings(),
          getChosenTake("fixed"),
          getChosenTake("fallback"),
          requestsThisMonth(),
          readWelcomeLog(),
        ]);
        return Response.json({ ok: true, settings, takes: { fixed, fallback }, used, limit: MONTHLY_LIMIT, stopAt: STOP_AT, log });
      }
      case "save":
        await saveWelcomeSettings(a.settings as Partial<WelcomeSettings>);
        return Response.json({ ok: true });
      case "generate": {
        const kind = kindOf(a.kind);
        const text = String(a.text ?? "");
        await saveWelcomeSettings(kind === "fixed" ? { fixedText: text } : { fallbackText: text });
        return Response.json({ ok: true, takes: await generateTakes(kind, text) });
      }
      case "choose":
        await chooseTake(kindOf(a.kind), Math.max(0, Math.min(TAKE_COUNT - 1, Number(a.i) || 0)));
        return Response.json({ ok: true });
      case "intro": {
        // Enregistrement « Enchantée » de la modèle (base64), collé devant le prénom
        const b64 = String(a.audio ?? "");
        if (b64.length < 1000 || b64.length > 900_000) throw new Error("Audio invalide (1 s à 600 Ko).");
        await getRedis().set("welcome:intro", b64);
        return Response.json({ ok: true });
      }
      case "upload": {
        // Vrai enregistrement de la modèle comme prise (fixe ou repli)
        const b64 = String(a.audio ?? "");
        if (b64.length < 1000 || b64.length > 900_000) throw new Error("Audio invalide (1 s à 600 Ko).");
        await uploadTake(kindOf(a.kind), String(a.text ?? ""), b64);
        return Response.json({ ok: true });
      }
      case "test": {
        const { name, mp3 } = await buildWelcomeVoice(String(a.pseudo ?? ""));
        return Response.json({ ok: true, name, audio: mp3.toString("base64") });
      }
      case "retry": {
        const s = await getWelcomeSettings();
        await handleNewSub(s.accountId, String(a.fan ?? ""), String(a.display ?? ""), String(a.username ?? ""));
        return Response.json({ ok: true });
      }
      default:
        return Response.json({ ok: false, error: "Action inconnue." }, { status: 400 });
    }
  } catch (err) {
    return Response.json({ ok: false, error: String((err as Error)?.message ?? err) }, { status: 500 });
  }
}

export async function GET(): Promise<Response> {
  return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const PAGE = /* html */ `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vocal de bienvenue</title>
<style>
:root{--bg:#f6f6f4;--card:#fff;--ink:#1b1b1a;--mute:#6d6d68;--line:#e3e3de;--accent:#c2416b;--soft:#fbeef2;--ok:#1f8a54;--ko:#c0392b}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecece8;--mute:#9a9a93;--line:#30302d;--accent:#ec6f97;--soft:#2b1d22;--ok:#4cc286;--ko:#ef6b5d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0}
.sub{color:var(--mute);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
label{display:block;font-size:13px;color:var(--mute);margin:12px 0 4px}
input,textarea{width:100%;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
textarea{min-height:64px;resize:vertical}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:8px 14px;cursor:pointer}
button.main{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.head{display:flex;justify-content:space-between;align-items:center;gap:10px}
.switch{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--ink);margin:0}
.switch input{width:auto}
.gauge{height:8px;background:var(--line);border-radius:4px;overflow:hidden;margin:8px 0 4px}
.gauge div{height:100%;background:var(--accent)}
.hint{font-size:12px;color:var(--mute)}
.msg{font-size:13px;margin-top:8px;min-height:18px}
.ok{color:var(--ok)}.ko{color:var(--ko)}
.current{background:var(--soft);border-radius:8px;padding:10px;margin-top:12px}
.take{display:flex;gap:10px;align-items:center;border-top:1px solid var(--line);padding:8px 0}
.take audio{flex:1;min-width:0}
audio{width:100%;height:36px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line);vertical-align:top}
.log-wrap{overflow-x:auto}
#login{max-width:340px;margin:15vh auto}
</style>
</head>
<body>
<main>
  <div id="login" class="card" hidden>
    <h2>Vocal de bienvenue</h2>
    <label for="pw">Mot de passe</label>
    <input id="pw" type="password" autocomplete="current-password">
    <div class="row" style="margin-top:12px"><button class="main" id="go">Entrer</button></div>
    <div class="msg ko" id="loginMsg"></div>
  </div>

  <div id="app" hidden>
    <h1>Vocal de bienvenue — Sienna</h1>
    <p class="sub">Chaque nouvel abonné reçoit « <b>Prénom</b>… + partie fixe ». Pseudo illisible : le vocal de repli.</p>

    <div class="card">
      <div class="head"><h2>Envoi automatique</h2>
        <label class="switch"><input type="checkbox" id="enabled"> Actif</label></div>
      <label for="accountId">Compte OnlyFansAPI de Sienna (acct_…)</label>
      <input id="accountId" placeholder="acct_xxxxxxxx">
      <label for="caption">Petit texte envoyé avec le vocal (facultatif)</label>
      <input id="caption" placeholder="vide = vocal seul">
      <label for="delayMax">Attente max avant l'envoi (secondes, 0 à 30)</label>
      <input id="delayMax" type="number" min="0" max="30">
      <div class="row" style="margin-top:14px"><button class="main" id="save">Enregistrer</button></div>
      <div class="msg" id="saveMsg"></div>
    </div>

    <div class="card" data-kind="fixed">
      <h2>Partie fixe</h2>
      <div class="hint">Dite après le prénom, la même pour tous les fans. Tags Fish acceptés au début : [soft tone], [whispering]…</div>
      <label>Texte</label>
      <textarea data-text></textarea>
      <div class="current" data-current></div>
      <div class="row" style="margin-top:12px"><button data-gen>Générer 5 prises</button></div>
      <div class="msg" data-msg></div>
      <div data-takes></div>
    </div>

    <div class="card" data-kind="fallback">
      <h2>Vocal de repli — pseudo illisible</h2>
      <div class="hint">Envoyé tel quel quand on ne trouve pas de prénom (« u48392011 », « xkq77 »…).</div>
      <label>Texte</label>
      <textarea data-text></textarea>
      <div class="current" data-current></div>
      <div class="row" style="margin-top:12px"><button data-gen>Générer 5 prises</button></div>
      <div class="msg" data-msg></div>
      <div data-takes></div>
    </div>

    <div class="card">
      <h2>Tester avec un pseudo</h2>
      <div class="hint">L'IA trouve le prénom (« Alex2595839Xxx » → Alex, « DarkKiller902 » → Dark) et fabrique le vocal final.</div>
      <div class="row" style="margin-top:10px">
        <input id="pseudo" placeholder="Alex2595839Xxx" style="flex:1;min-width:160px">
        <button class="main" id="test">▶ Écouter</button>
      </div>
      <div class="msg" id="testMsg"></div>
      <div id="testAudio"></div>
    </div>

    <div class="card">
      <div class="head"><h2>Requêtes OnlyFansAPI ce mois</h2><span id="quota"></span></div>
      <div class="gauge"><div id="gauge"></div></div>
      <div class="hint" id="quotaHint"></div>
    </div>

    <div class="card">
      <div class="head"><h2>Derniers envois</h2><button id="refresh">Rafraîchir</button></div>
      <div class="log-wrap"><table id="log"></table></div>
    </div>
  </div>
</main>
<script>
const $ = (s, el = document) => el.querySelector(s);
let KEY = "";
try { KEY = localStorage.getItem("welcomeKey") || ""; } catch {}

async function call(action, data = {}) {
  const r = await fetch(location.pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-key": KEY },
    body: JSON.stringify({ action, ...data }),
  });
  const j = await r.json().catch(() => ({ ok: false, error: "Réponse illisible" }));
  if (r.status === 401) { showLogin("Mot de passe incorrect."); throw new Error(j.error); }
  if (!j.ok) throw new Error(j.error || "Erreur");
  return j;
}

function showLogin(msg) {
  $("#app").hidden = true; $("#login").hidden = false;
  $("#loginMsg").textContent = msg || "";
}
function say(el, text, ok) { el.textContent = text; el.className = "msg " + (ok ? "ok" : "ko"); }
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const player = (b64, type = "audio/mpeg") => '<audio controls preload="none" src="data:' + type + ';base64,' + b64 + '"></audio>';

$("#go").onclick = () => {
  KEY = $("#pw").value;
  try { localStorage.setItem("welcomeKey", KEY); } catch {}
  load();
};
$("#pw").onkeydown = (e) => { if (e.key === "Enter") $("#go").click(); };
$("#refresh").onclick = () => load();

$("#save").onclick = async (e) => {
  const s = { enabled: $("#enabled").checked, accountId: $("#accountId").value, caption: $("#caption").value, delayMax: Number($("#delayMax").value) };
  if (s.enabled && !s.accountId.trim()) return say($("#saveMsg"), "Pour activer : renseigne le compte acct_….", false);
  if (s.enabled && (!DATA.takes.fixed || !DATA.takes.fallback)) return say($("#saveMsg"), "Pour activer : choisis d'abord une prise pour la partie fixe ET pour le repli.", false);
  e.target.disabled = true;
  try { await call("save", { settings: s }); say($("#saveMsg"), "Enregistré.", true); }
  catch (err) { say($("#saveMsg"), err.message, false); }
  e.target.disabled = false;
};

document.querySelectorAll("[data-kind]").forEach((card) => {
  const kind = card.dataset.kind;
  $("[data-gen]", card).onclick = async (e) => {
    const text = $("[data-text]", card).value.trim();
    if (!text) return say($("[data-msg]", card), "Écris d'abord le texte.", false);
    e.target.disabled = true; say($("[data-msg]", card), "Génération des 5 prises… (10 à 20 s)", true);
    try {
      const r = await call("generate", { kind, text });
      say($("[data-msg]", card), "Écoute et choisis ta préférée.", true);
      $("[data-takes]", card).innerHTML = r.takes.map((b, i) =>
        '<div class="take"><b>' + (i + 1) + '</b>' + player(b) + '<button data-choose="' + i + '">Choisir</button></div>').join("");
      card.querySelectorAll("[data-choose]").forEach((b) => b.onclick = async () => {
        b.disabled = true;
        try { await call("choose", { kind, i: Number(b.dataset.choose) }); $("[data-takes]", card).innerHTML = ""; say($("[data-msg]", card), "Prise " + (Number(b.dataset.choose) + 1) + " installée.", true); load(); }
        catch (err) { say($("[data-msg]", card), err.message, false); b.disabled = false; }
      });
    } catch (err) { say($("[data-msg]", card), err.message, false); }
    e.target.disabled = false;
  };
});

$("#test").onclick = async (e) => {
  const pseudo = $("#pseudo").value.trim();
  if (!pseudo) return say($("#testMsg"), "Écris un pseudo.", false);
  e.target.disabled = true; say($("#testMsg"), "Fabrication du vocal…", true); $("#testAudio").innerHTML = "";
  try {
    const r = await call("test", { pseudo });
    say($("#testMsg"), r.name ? "Prénom trouvé : " + r.name : "Pseudo illisible → vocal de repli", true);
    $("#testAudio").innerHTML = player(r.audio);
    $("#testAudio audio").play().catch(() => {});
  } catch (err) { say($("#testMsg"), err.message, false); }
  e.target.disabled = false;
};
$("#pseudo").onkeydown = (e) => { if (e.key === "Enter") $("#test").click(); };

function renderLog(log) {
  const t = $("#log");
  if (!log.length) { t.innerHTML = '<tr><td class="hint">Aucun envoi pour l\\'instant.</td></tr>'; return; }
  t.innerHTML = "<tr><th>Date</th><th>Pseudo</th><th>Prénom dit</th><th>État</th><th></th></tr>" + log.map((l, i) => \`
    <tr><td>\${new Date(l.at).toLocaleString("fr-FR")}</td>
    <td>\${esc(l.display)}\${l.username ? " @" + esc(l.username) : ""}</td>
    <td>\${l.name ? esc(l.name) : '<span class="hint">repli</span>'}</td>
    <td class="\${l.ok ? "ok" : "ko"}">\${l.ok ? "Envoyé" : "Échec : " + esc(l.error)}</td>
    <td>\${l.ok ? "" : '<button data-retry="' + i + '">Renvoyer</button>'}</td></tr>\`).join("");
  t.querySelectorAll("[data-retry]").forEach((b) => b.onclick = async () => {
    const l = log[Number(b.dataset.retry)];
    b.disabled = true; b.textContent = "…";
    try { await call("retry", { fan: l.fan, display: l.display, username: l.username }); } catch {}
    load();
  });
}

let DATA = null;
async function load() {

  try { DATA = await call("load"); } catch (err) { if ($("#login").hidden) alert(err.message); return; }
  const d = DATA, s = d.settings;
  $("#login").hidden = true; $("#app").hidden = false;
  $("#enabled").checked = s.enabled;
  $("#accountId").value = s.accountId;
  $("#caption").value = s.caption;
  $("#delayMax").value = s.delayMax;
  for (const kind of ["fixed", "fallback"]) {
    const card = $('[data-kind="' + kind + '"]');
    const ta = $("[data-text]", card);
    if (document.activeElement !== ta) ta.value = kind === "fixed" ? s.fixedText : s.fallbackText;
    const t = d.takes[kind];
    $("[data-current]", card).innerHTML = t
      ? '<div class="hint">Prise en service (' + new Date(t.at).toLocaleDateString("fr-FR") + ') : « ' + esc(t.text) + ' »</div>' + player(t.audio)
      : '<div class="hint">Aucune prise choisie : génère 5 prises et choisis-en une.</div>';
  }
  const pct = Math.min(100, (d.used / d.limit) * 100);
  $("#quota").textContent = d.used.toLocaleString("fr-FR") + " / " + d.limit.toLocaleString("fr-FR");
  $("#gauge").style.width = pct + "%";
  $("#quotaHint").textContent = d.used >= d.stopAt
    ? "Envois bloqués : seuil de sécurité atteint (" + d.stopAt.toLocaleString("fr-FR") + ")."
    : "Environ 2 requêtes par nouvel abonné. Blocage automatique à " + d.stopAt.toLocaleString("fr-FR") + ".";
  renderLog(d.log);
}
load();
</script>
</body>
</html>`;
