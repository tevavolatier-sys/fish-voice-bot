// Interface web du vocal de bienvenue (Sienna) : https://<projet>.vercel.app/api/welcome
// GET  → la page (aucune donnée dedans)
// POST → actions, protégées par le mot de passe WELCOME_ADMIN_PASSWORD (Vercel)
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
        await handleNewSub(s.accountId, String(a.fan ?? ""), String(a.display ?? ""), String(a.username ?? ""), { force: true });
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
<title>Vocal de bienvenue — Sienna</title>
<style>
:root{--bg:#f4f4f1;--card:#fff;--ink:#1b1b1a;--mute:#6d6d68;--line:#e3e3de;--accent:#c2416b;--soft:#fbeef2;--ok:#1f8a54;--okbg:#e6f6ec;--warn:#b7791f;--warnbg:#fdf3e1;--ko:#c0392b;--kobg:#fdecea}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecece8;--mute:#9a9a93;--line:#30302d;--accent:#ec6f97;--soft:#2b1d22;--ok:#4cc286;--okbg:#17301f;--warn:#e2a93b;--warnbg:#332a14;--ko:#ef6b5d;--kobg:#3a1c19}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:860px;margin:0 auto;padding:20px 16px 80px}
h1{font-size:22px;margin:0}h2{font-size:16px;margin:0}h3{font-size:14px;margin:14px 0 4px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.pill{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:6px 12px;font-weight:600;font-size:14px}
.pill.on{background:var(--okbg);color:var(--ok)}.pill.off{background:var(--kobg);color:var(--ko)}
.pill i{width:9px;height:9px;border-radius:50%;background:currentColor;display:inline-block}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:14px}
.card p.lead{margin:4px 0 0;color:var(--mute);font-size:14px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-top:12px}
.stat{background:var(--bg);border-radius:10px;padding:10px 12px}
.stat b{display:block;font-size:22px;line-height:1.2}.stat span{font-size:12px;color:var(--mute)}
.stat.ok b{color:var(--ok)}.stat.warn b{color:var(--warn)}.stat.ko b{color:var(--ko)}
label{display:block;font-size:13px;color:var(--mute);margin:12px 0 4px}
input,textarea,select{width:100%;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:9px 10px}
textarea{min-height:64px;resize:vertical}
input[type=file]{padding:6px}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:9px 14px;cursor:pointer}
button.main{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
button.sm{padding:5px 10px;font-size:13px}
button:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
@media(max-width:600px){.grid2{grid-template-columns:1fr}}
.switch{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:600;margin:0;cursor:pointer}
.switch input{width:22px;height:22px;accent-color:var(--ok)}
.gauge{height:10px;background:var(--line);border-radius:5px;overflow:hidden;margin:8px 0 4px}
.gauge div{height:100%;background:var(--ok)}
.hint{font-size:12.5px;color:var(--mute)}
.msg{font-size:13px;margin-top:8px;min-height:18px}
.ok{color:var(--ok)}.ko{color:var(--ko)}.warn{color:var(--warn)}
.current{background:var(--soft);border-radius:10px;padding:10px 12px;margin-top:10px}
.take{display:flex;gap:10px;align-items:center;border-top:1px solid var(--line);padding:8px 0}
.take audio{flex:1;min-width:0}
audio{width:100%;height:36px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--mute);font-weight:600}
.tag{display:inline-block;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600;white-space:nowrap}
.tag.sent{background:var(--okbg);color:var(--ok)}.tag.late{background:var(--warnbg);color:var(--warn)}.tag.error{background:var(--kobg);color:var(--ko)}
.log-wrap{overflow-x:auto}
details{margin-top:10px}summary{cursor:pointer;color:var(--mute);font-size:13px}
#login{max-width:360px;margin:15vh auto}
.steps{margin:8px 0 0;padding-left:18px;color:var(--mute);font-size:14px}
.steps li{margin:3px 0}
</style>
</head>
<body>
<main>
  <div id="login" class="card" hidden>
    <h2>Vocal de bienvenue — Sienna</h2>
    <label for="pw">Mot de passe</label>
    <input id="pw" type="password" autocomplete="current-password">
    <div class="row" style="margin-top:12px"><button class="main" id="go">Entrer</button></div>
    <div class="msg ko" id="loginMsg"></div>
  </div>

  <div id="app" hidden>
    <div class="top">
      <div><h1>Vocal de bienvenue — Sienna</h1><div class="hint">Chaque nouvel abonné reçoit un vocal « Enchantée <b>Prénom</b>… moi c'est Sienna, bienvenue ».</div></div>
      <div class="row"><span class="pill" id="pill"><i></i><span id="pillText"></span></span><button id="refresh">↻ Actualiser</button></div>
    </div>

    <div class="card">
      <div class="head"><h2>Aujourd'hui</h2><span class="hint" id="lastSent"></span></div>
      <div class="stats">
        <div class="stat ok"><b id="stSent">0</b><span>vocaux envoyés</span></div>
        <div class="stat warn"><b id="stLate">0</b><span>trop tard, pas envoyés</span></div>
        <div class="stat ko"><b id="stErr">0</b><span>échecs</span></div>
        <div class="stat"><b id="stAvg">–</b><span>délai moyen d'envoi</span></div>
      </div>
      <div class="hint" id="blockers" style="margin-top:10px"></div>
    </div>

    <div class="card">
      <div class="head"><h2>Réglages</h2>
        <label class="switch"><input type="checkbox" id="enabled"> <span id="enabledLabel">Envoi automatique</span></label></div>
      <div class="grid2">
        <div>
          <label for="maxDelaySec">Délai maximum après l'abonnement (secondes)</label>
          <input id="maxDelaySec" type="number" min="10" max="3600" step="10">
          <div class="hint">Passé ce délai, le vocal n'est <b>pas</b> envoyé (le fan est déjà passé à autre chose). 120 = 2 minutes.</div>
        </div>
        <div>
          <label for="delayMax">Attente « naturelle » avant l'envoi (secondes, 0 à 30)</label>
          <input id="delayMax" type="number" min="0" max="30">
          <div class="hint">Tirée au hasard entre 0 et cette valeur, pour ne pas répondre à la seconde près.</div>
        </div>
      </div>
      <label for="caption">Texte envoyé avec le vocal (facultatif)</label>
      <input id="caption" placeholder="vide = vocal seul">
      <details><summary>Avancé : compte OnlyFansAPI</summary>
        <label for="accountId">Identifiant du compte (acct_…)</label>
        <input id="accountId" placeholder="acct_xxxxxxxx">
      </details>
      <div class="row" style="margin-top:14px"><button class="main" id="save">Enregistrer</button><span class="msg" id="saveMsg" style="margin:0"></span></div>
    </div>

    <div class="card">
      <h2>Requêtes OnlyFansAPI ce mois</h2>
      <div class="head" style="margin-top:6px"><span id="quota"></span><span class="hint" id="quotaLeft"></span></div>
      <div class="gauge"><div id="gauge"></div></div>
      <div class="hint" id="quotaHint"></div>
    </div>

    <div class="card">
      <h2>Tester avec un pseudo</h2>
      <p class="lead">Fabrique le vocal exactement comme pour un vrai fan (rien n'est envoyé).</p>
      <div class="row" style="margin-top:10px">
        <input id="pseudo" placeholder="Alex2595839Xxx" style="flex:1;min-width:160px">
        <button class="main" id="test">▶ Écouter</button>
      </div>
      <div class="msg" id="testMsg"></div>
      <div id="testAudio"></div>
    </div>

    <div class="card" data-kind="fixed">
      <h2>Partie fixe : « moi c'est Sienna, bienvenue »</h2>
      <p class="lead">Dite après « Enchantée Prénom… », la même pour tous. Soit un vrai enregistrement de Sienna (le mieux), soit une prise Fish.</p>
      <div class="current" data-current></div>
      <h3>Remplacer par un vrai enregistrement</h3>
      <div class="row"><input type="file" accept="audio/*" data-file style="flex:1;min-width:200px"><button data-upload>Installer</button></div>
      <h3>Ou générer avec la voix Fish</h3>
      <label>Texte (tags acceptés au début : [soft tone], [whispering]…)</label>
      <textarea data-text></textarea>
      <div class="row" style="margin-top:10px"><button data-gen>Générer 5 prises</button></div>
      <div class="msg" data-msg></div>
      <div data-takes></div>
    </div>

    <div class="card" data-kind="fallback">
      <h2>Vocal de repli : pseudo illisible</h2>
      <p class="lead">Envoyé tel quel quand aucun prénom n'est lisible (« u48392011 », « xkq77 »…).</p>
      <div class="current" data-current></div>
      <h3>Remplacer par un vrai enregistrement</h3>
      <div class="row"><input type="file" accept="audio/*" data-file style="flex:1;min-width:200px"><button data-upload>Installer</button></div>
      <h3>Ou générer avec la voix Fish</h3>
      <label>Texte</label>
      <textarea data-text></textarea>
      <div class="row" style="margin-top:10px"><button data-gen>Générer 5 prises</button></div>
      <div class="msg" data-msg></div>
      <div data-takes></div>
    </div>

    <div class="card">
      <div class="head"><h2>Journal des envois</h2>
        <select id="filter" style="width:auto"><option value="">Tout</option><option value="sent">Envoyés</option><option value="late">Trop tard</option><option value="error">Échecs</option></select></div>
      <div class="log-wrap" style="margin-top:10px"><table id="log"></table></div>
      <div class="hint" style="margin-top:8px">« Renvoyer » force l'envoi maintenant, même si le délai est dépassé.</div>
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
  if (r.status === 401) { showLogin(KEY ? "Mot de passe incorrect." : ""); throw new Error(j.error); }
  if (!j.ok) throw new Error(j.error || "Erreur");
  return j;
}
function showLogin(msg) { $("#app").hidden = true; $("#login").hidden = false; $("#loginMsg").textContent = msg || ""; }
function say(el, text, cls) { el.textContent = text; el.className = "msg " + (cls === true ? "ok" : cls === false ? "ko" : cls || ""); }
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const player = (b64, type = "audio/mpeg") => '<audio controls preload="none" src="data:' + type + ';base64,' + b64 + '"></audio>';
const fmtSec = (s) => s == null ? "–" : s < 60 ? Math.round(s) + " s" : Math.floor(s / 60) + " min " + Math.round(s % 60) + " s";
const fileB64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = rej; r.readAsDataURL(f); });

$("#go").onclick = () => { KEY = $("#pw").value; try { localStorage.setItem("welcomeKey", KEY); } catch {} load(); };
$("#pw").onkeydown = (e) => { if (e.key === "Enter") $("#go").click(); };
$("#refresh").onclick = () => load();
$("#filter").onchange = () => renderLog(DATA.log);
$("#enabled").onchange = () => { $("#enabledLabel").textContent = $("#enabled").checked ? "Envoi automatique : ACTIF" : "Envoi automatique : ARRÊTÉ"; };

$("#save").onclick = async (e) => {
  const s = { enabled: $("#enabled").checked, accountId: $("#accountId").value, caption: $("#caption").value,
    delayMax: Number($("#delayMax").value), maxDelaySec: Number($("#maxDelaySec").value) };
  if (s.enabled && !s.accountId.trim()) return say($("#saveMsg"), "Pour activer : renseigne le compte acct_… (Avancé).", false);
  if (s.enabled && (!DATA.takes.fixed || !DATA.takes.fallback)) return say($("#saveMsg"), "Pour activer : installe d'abord la partie fixe ET le vocal de repli.", false);
  e.target.disabled = true;
  try { await call("save", { settings: s }); say($("#saveMsg"), "Enregistré ✓", true); load(); }
  catch (err) { say($("#saveMsg"), err.message, false); }
  e.target.disabled = false;
};

document.querySelectorAll("[data-kind]").forEach((card) => {
  const kind = card.dataset.kind;
  const msg = $("[data-msg]", card);
  $("[data-upload]", card).onclick = async (e) => {
    const f = $("[data-file]", card).files[0];
    if (!f) return say(msg, "Choisis d'abord un fichier audio (mp3, ogg, m4a…).", false);
    if (f.size > 600 * 1024) return say(msg, "Fichier trop gros (max 600 Ko) : raccourcis-le.", false);
    e.target.disabled = true; say(msg, "Installation…", true);
    try { await call("upload", { kind, text: $("[data-text]", card).value.trim(), audio: await fileB64(f) }); say(msg, "Enregistrement installé ✓ Teste avec un pseudo pour vérifier.", true); load(); }
    catch (err) { say(msg, err.message, false); }
    e.target.disabled = false;
  };
  $("[data-gen]", card).onclick = async (e) => {
    const text = $("[data-text]", card).value.trim();
    if (!text) return say(msg, "Écris d'abord le texte.", false);
    e.target.disabled = true; say(msg, "Génération des 5 prises… (10 à 20 s)", true);
    try {
      const r = await call("generate", { kind, text });
      say(msg, "Écoute et choisis ta préférée.", true);
      $("[data-takes]", card).innerHTML = r.takes.map((b, i) =>
        '<div class="take"><b>' + (i + 1) + '</b>' + player(b) + '<button class="sm" data-choose="' + i + '">Choisir</button></div>').join("");
      card.querySelectorAll("[data-choose]").forEach((b) => b.onclick = async () => {
        b.disabled = true;
        try { await call("choose", { kind, i: Number(b.dataset.choose) }); $("[data-takes]", card).innerHTML = ""; say(msg, "Prise " + (Number(b.dataset.choose) + 1) + " installée ✓", true); load(); }
        catch (err) { say(msg, err.message, false); b.disabled = false; }
      });
    } catch (err) { say(msg, err.message, false); }
    e.target.disabled = false;
  };
});

$("#test").onclick = async (e) => {
  const pseudo = $("#pseudo").value.trim();
  if (!pseudo) return say($("#testMsg"), "Écris un pseudo.", false);
  e.target.disabled = true; say($("#testMsg"), "Fabrication du vocal… (10 à 20 s)", true); $("#testAudio").innerHTML = "";
  try {
    const r = await call("test", { pseudo });
    say($("#testMsg"), r.name ? "Prénom trouvé : " + r.name : "Pseudo illisible → vocal de repli", true);
    $("#testAudio").innerHTML = player(r.audio);
    $("#testAudio audio").play().catch(() => {});
  } catch (err) { say($("#testMsg"), err.message, false); }
  e.target.disabled = false;
};
$("#pseudo").onkeydown = (e) => { if (e.key === "Enter") $("#test").click(); };

const statusOf = (l) => l.status || (l.ok ? "sent" : "error");
const TAG = { sent: "Envoyé", late: "Trop tard", error: "Échec" };

function renderLog(log) {
  const f = $("#filter").value;
  const rows = log.map((l, i) => [l, i]).filter(([l]) => !f || statusOf(l) === f);
  const t = $("#log");
  if (!rows.length) { t.innerHTML = '<tr><td class="hint">Rien pour l\\'instant.</td></tr>'; return; }
  t.innerHTML = "<tr><th>Quand</th><th>Fan</th><th>Prénom dit</th><th>Délai</th><th>État</th><th></th></tr>" + rows.map(([l, i]) => {
    const st = statusOf(l);
    const detail = st === "sent" ? (l.manual ? "renvoi manuel" : "") : esc((l.error || "").replace(/^Trop tard : /, ""));
    return \`<tr><td>\${new Date(l.at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
    <td>\${esc(l.display || l.fan)}\${l.username ? '<div class="hint">@' + esc(l.username) + "</div>" : ""}</td>
    <td>\${l.name ? esc(l.name) : '<span class="hint">repli</span>'}</td>
    <td>\${fmtSec(l.elapsedSec)}</td>
    <td><span class="tag \${st}">\${TAG[st]}</span>\${detail ? '<div class="hint">' + detail + "</div>" : ""}</td>
    <td>\${st === "sent" ? "" : '<button class="sm" data-retry="' + i + '">Renvoyer</button>'}</td></tr>\`;
  }).join("");
  t.querySelectorAll("[data-retry]").forEach((b) => b.onclick = async () => {
    const l = log[Number(b.dataset.retry)];
    if (!confirm("Envoyer le vocal maintenant à " + (l.display || l.fan) + " ?")) return;
    b.disabled = true; b.textContent = "Envoi…";
    try { await call("retry", { fan: l.fan, display: l.display, username: l.username }); } catch (err) { alert(err.message); }
    load();
  });
}

let DATA = null;
async function load() {
  try { DATA = await call("load"); } catch (err) { if ($("#login").hidden) alert(err.message); return; }
  const d = DATA, s = d.settings;
  $("#login").hidden = true; $("#app").hidden = false;
  const ready = s.enabled && s.accountId && d.takes.fixed && d.takes.fallback && d.used < d.stopAt;
  $("#pill").className = "pill " + (ready ? "on" : "off");
  $("#pillText").textContent = ready ? "En marche : les nouveaux abonnés reçoivent le vocal" : "Arrêté : rien n'est envoyé";
  const why = [];
  if (!s.enabled) why.push("l'envoi automatique est désactivé (Réglages)");
  if (!s.accountId) why.push("le compte acct_… n'est pas renseigné");
  if (!d.takes.fixed) why.push("la partie fixe n'est pas installée");
  if (!d.takes.fallback) why.push("le vocal de repli n'est pas installé");
  if (d.used >= d.stopAt) why.push("le quota OnlyFansAPI est atteint");
  $("#blockers").innerHTML = why.length ? "⚠️ Pour que ça parte : " + why.join(" · ") + "." : "";
  $("#enabled").checked = s.enabled; $("#enabled").onchange();
  $("#accountId").value = s.accountId; $("#caption").value = s.caption;
  $("#delayMax").value = s.delayMax; $("#maxDelaySec").value = s.maxDelaySec;
  for (const kind of ["fixed", "fallback"]) {
    const card = $('[data-kind="' + kind + '"]');
    const ta = $("[data-text]", card);
    if (document.activeElement !== ta) ta.value = kind === "fixed" ? s.fixedText : s.fallbackText;
    const t = d.takes[kind];
    $("[data-current]", card).innerHTML = t
      ? '<div class="hint">✓ En service depuis le ' + new Date(t.at).toLocaleDateString("fr-FR") + (t.text ? ' : « ' + esc(t.text) + ' »' : "") + "</div>" + player(t.audio)
      : '<div class="ko">Rien d\\'installé : charge un enregistrement ou génère des prises.</div>';
  }
  const today = new Date().toDateString();
  const todays = d.log.filter((l) => new Date(l.at).toDateString() === today);
  const n = (st) => todays.filter((l) => statusOf(l) === st).length;
  $("#stSent").textContent = n("sent"); $("#stLate").textContent = n("late"); $("#stErr").textContent = n("error");
  const sent = d.log.filter((l) => statusOf(l) === "sent" && l.elapsedSec != null);
  $("#stAvg").textContent = sent.length ? fmtSec(sent.reduce((a, l) => a + l.elapsedSec, 0) / sent.length) : "–";
  const last = d.log.find((l) => statusOf(l) === "sent");
  $("#lastSent").textContent = last ? "Dernier envoi : " + new Date(last.at).toLocaleString("fr-FR") + " (" + esc(last.display || last.fan) + ")" : "Aucun envoi pour l'instant";
  const pct = Math.min(100, (d.used / d.limit) * 100);
  $("#quota").innerHTML = "<b>" + d.used.toLocaleString("fr-FR") + "</b> / " + d.limit.toLocaleString("fr-FR");
  $("#quotaLeft").textContent = "≈ " + Math.max(0, Math.floor((d.stopAt - d.used) / 2)).toLocaleString("fr-FR") + " vocaux encore possibles ce mois";
  $("#gauge").style.width = pct + "%";
  $("#gauge").style.background = d.used >= d.stopAt ? "var(--ko)" : pct > 70 ? "var(--warn)" : "var(--ok)";
  $("#quotaHint").textContent = d.used >= d.stopAt
    ? "Envois bloqués : seuil de sécurité atteint (" + d.stopAt.toLocaleString("fr-FR") + ")."
    : "2 requêtes par vocal (envoi du fichier + message). Blocage automatique à " + d.stopAt.toLocaleString("fr-FR") + ". Remise à zéro chaque mois.";
  renderLog(d.log);
}
load();
</script>
</body>
</html>`;
