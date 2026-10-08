// Interface web du vocal de bienvenue (Sienna) : https://<projet>.vercel.app/api/welcome
// GET  → la page (aucune donnée dedans)
// POST → actions, protégées par le mot de passe WELCOME_ADMIN_PASSWORD (Vercel)
import { timingSafeEqual } from "node:crypto";
import { abReset, abStats } from "../lib/ab.js";
import { fanFirstName, llmProviders } from "../lib/fan-name.js";
import { getSelfiePhoto, getSelfieSettings, makeSelfie, saveSelfiePhoto, saveSelfieSettings, selfieGuide, type SelfieSettings } from "../lib/selfie.js";
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
        const ab = settings.accountId ? await abStats(settings.accountId) : null;
        return Response.json({ ok: true, settings, takes: { fixed, fallback }, used, limit: MONTHLY_LIMIT, stopAt: STOP_AT, log, ab });
      }
      case "abReset": {
        const s = await getWelcomeSettings();
        if (s.accountId) await abReset(s.accountId);
        return Response.json({ ok: true });
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
      case "selfieLoad":
        return Response.json({ ok: true, settings: await getSelfieSettings(), hasPhoto: Boolean(await getSelfiePhoto()) });
      case "selfiePhoto": {
        const b64 = String(a.image ?? "");
        if (b64.length < 1000 || b64.length > 12_000_000) throw new Error("Photo invalide (max 8 Mo).");
        return Response.json({ ok: true, ...(await saveSelfiePhoto(Buffer.from(b64, "base64"))) });
      }
      case "selfieSave":
        await saveSelfieSettings(a.settings as Partial<SelfieSettings>);
        return Response.json({ ok: true });
      case "selfieZone": {
        // Aperçu de la zone d'écriture (liseré rouge) sur la photo installée
        await saveSelfieSettings(a.settings as Partial<SelfieSettings>);
        const photo = await getSelfiePhoto();
        if (!photo) throw new Error("Aucune photo de base : charge d'abord le selfie.");
        return Response.json({ ok: true, image: (await selfieGuide(photo, await getSelfieSettings())).toString("base64") });
      }
      case "selfieTest": {
        const name = await fanFirstName(String(a.pseudo ?? ""));
        if (!name) return Response.json({ ok: true, name: "", image: null });
        const r = await makeSelfie(name, { force: true, mode: a.mode === "text" ? "text" : a.mode === "ai" ? "ai" : undefined });
        if (!r) throw new Error("Aucune photo de base : charge d'abord le selfie.");
        return Response.json({ ok: true, name, how: r.how, aiError: r.aiError, image: r.jpeg.toString("base64") });
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

export async function GET(req?: Request): Promise<Response> {
  // Contrôle de santé de l'IA des prénoms (pseudo fixe, rien de secret) : /api/welcome?check=name
  if (req && new URL(req.url).searchParams.get("check") === "name") {
    const name = await fanFirstName("Alex2595839Xxx");
    const llm = llmProviders();
    return Response.json({ name, llm, viaLlm: llm.length > 0 && name === "Alex" });
  }
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
#toggle.off{background:var(--ko);border-color:var(--ko)}#toggle.on{background:var(--ok);border-color:var(--ok)}
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
.ab-wrap{overflow-x:auto;margin-top:14px}
table.ab{width:100%;border-collapse:collapse;font-size:14px}
table.ab th,table.ab td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
table.ab th:first-child,table.ab td:first-child{text-align:left;color:var(--mute);font-weight:400}
table.ab thead th{color:var(--ink);font-weight:600}
table.ab td b{font-size:16px}
.bar{height:8px;background:var(--line);border-radius:4px;overflow:hidden;margin-top:6px}
.bar div{height:100%}
.tag{display:inline-block;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600;white-space:nowrap}
.tag.sent{background:var(--okbg);color:var(--ok)}.tag.late{background:var(--warnbg);color:var(--warn)}.tag.error{background:var(--kobg);color:var(--ko)}.tag.control{background:var(--line);color:var(--mute)}
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
      <div class="row"><span class="pill" id="pill"><i></i><span id="pillText"></span></span><button class="main" id="toggle" style="min-width:110px">…</button><button id="refresh">↻ Actualiser</button></div>
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
      <div class="head"><h2>Test A/B : vocal ou pas ?</h2>
        <label class="switch"><input type="checkbox" id="abEnabled"> <span id="abLabel">Test</span></label></div>
      <p class="lead">Un nouvel abonné sur deux ne reçoit <b>pas</b> le vocal. On compare ensuite qui a écrit dans les 48 h. Les chatters ne voient rien.</p>
      <div class="stats" id="abStats"></div>
      <div class="ab-wrap"><table id="abTable" class="ab"></table></div>
      <div class="hint" id="abHint" style="margin-top:10px"></div>
      <div class="row" style="margin-top:10px"><button class="sm" id="abReset">Remettre le test à zéro</button></div>
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

    <div class="card" id="selfieCard">
      <div class="head"><h2>Selfie « papier avec le prénom »</h2>
        <label class="switch"><input type="checkbox" id="sfEnabled"> <span id="sfLabel">Selfie</span></label></div>
      <p class="lead">Envoyé avec le vocal : la photo d'elle avec le papier, le prénom du fan écrit dessus. Pseudo illisible → pas de selfie.</p>
      <div class="grid2">
        <div>
          <label>Photo de base (elle + papier blanc vide)</label>
          <div class="row"><input type="file" id="sfFile" accept="image/*" style="flex:1"><button class="sm" id="sfUpload">Installer</button></div>
          <div class="hint" id="sfPhotoState"></div>
        </div>
        <div>
          <label>Méthode</label>
          <select id="sfMode"><option value="ai">IA Gemini (vrai inpainting, ~15 s)</option><option value="text">Texte posé (1 s, sans IA, fait faux)</option></select>
          <label class="switch" style="margin-top:8px"><input type="checkbox" id="sfFallback"> Si l'IA échoue : poser le texte quand même (sinon pas de selfie)</label>
          <label for="sfPrompt">Consigne IA en plus (facultatif)</label>
          <input id="sfPrompt" placeholder="ex. écris aussi « Bienvenue » au-dessus">
        </div>
      </div>
      <label>Zone d'écriture sur la feuille (liseré rouge montré à l'IA : le prénom reste dedans, loin de la main)</label>
      <div class="grid2">
        <div><label>Haut-gauche (x, y en %)</label><div class="row"><input data-z="0,0" type="number" min="0" max="100"><input data-z="0,1" type="number" min="0" max="100"></div></div>
        <div><label>Haut-droit</label><div class="row"><input data-z="1,0" type="number" min="0" max="100"><input data-z="1,1" type="number" min="0" max="100"></div></div>
        <div><label>Bas-droit</label><div class="row"><input data-z="2,0" type="number" min="0" max="100"><input data-z="2,1" type="number" min="0" max="100"></div></div>
        <div><label>Bas-gauche</label><div class="row"><input data-z="3,0" type="number" min="0" max="100"><input data-z="3,1" type="number" min="0" max="100"></div></div>
      </div>
      <div class="row" style="margin-top:8px"><button class="sm" id="sfZone">Voir la zone sur la photo</button></div>
      <details><summary>Réglages du texte posé (position du prénom sur le papier)</summary>
        <div class="grid2">
          <div><label>Centre horizontal (% largeur)</label><input id="sfX" type="number" min="0" max="100"></div>
          <div><label>Centre vertical (% hauteur)</label><input id="sfY" type="number" min="0" max="100"></div>
          <div><label>Inclinaison (°)</label><input id="sfAngle" type="number" min="-45" max="45" step="0.5"></div>
          <div><label>Taille (% largeur)</label><input id="sfSize" type="number" min="3" max="60"></div>
          <div><label>Largeur max du prénom (% largeur)</label><input id="sfMaxW" type="number" min="5" max="100"></div>
        </div>
      </details>
      <div class="row" style="margin-top:12px"><button class="main" id="sfSave">Enregistrer</button>
        <input id="sfPseudo" placeholder="Pseudo test (Alex2595839Xxx)" style="flex:1;min-width:160px">
        <button id="sfTest">🖼️ Essayer</button></div>
      <div class="msg" id="sfMsg"></div>
      <div id="sfOut" style="margin-top:8px"></div>
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
        <select id="filter" style="width:auto"><option value="">Tout</option><option value="sent">Envoyés</option><option value="control">Sans vocal (test)</option><option value="late">Trop tard</option><option value="error">Échecs</option></select></div>
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
// Bouton ON/OFF en haut : enregistre tout de suite, sans passer par « Enregistrer »
$("#toggle").onclick = async (e) => {
  const on = !DATA.settings.enabled;
  if (on && (!DATA.takes.fixed || !DATA.takes.fallback)) return alert("Installe d'abord la partie fixe ET le vocal de repli.");
  e.target.disabled = true;
  try { await call("save", { settings: { enabled: on } }); } catch (err) { alert(err.message); }
  await load(); e.target.disabled = false;
};
$("#filter").onchange = () => renderLog(DATA.log);
$("#enabled").onchange = () => { $("#enabledLabel").textContent = $("#enabled").checked ? "Envoi automatique : ACTIF" : "Envoi automatique : ARRÊTÉ"; };
$("#abEnabled").onchange = async (e) => {
  const on = e.target.checked;
  e.target.disabled = true;
  try { await call("save", { settings: { abEnabled: on } }); } catch (err) { alert(err.message); }
  await load(); e.target.disabled = false;
};
$("#abReset").onclick = async () => {
  if (!confirm("Effacer tous les fans du test A/B et repartir de zéro ?")) return;
  try { await call("abReset"); } catch (err) { alert(err.message); }
  load();
};
const pct = (r) => r == null ? "–" : Math.round(r * 100) + " %";
function renderAb(ab, on) {
  $("#abLabel").textContent = on ? "Test A/B : EN COURS" : "Test A/B : arrêté (tout le monde reçoit le vocal)";
  if (!ab) { $("#abStats").innerHTML = ""; $("#abTable").innerHTML = ""; $("#abHint").textContent = "Renseigne le compte acct_… pour démarrer."; return; }
  const v = ab.voice, n = ab.none;
  const sign = (x) => (x > 0 ? "+" : "") + x;
  const mins = (m) => m == null ? "–" : m < 60 ? Math.round(m) + " min" : m < 1440 ? (m / 60).toFixed(1).replace(".0", "") + " h" : (m / 1440).toFixed(1).replace(".0", "") + " j";
  const conf = ab.confidence == null ? null : Math.round(ab.confidence * 100);
  $("#abStats").innerHTML =
    '<div class="stat ok"><b>' + pct(v.rate) + '</b><span>répondent AVEC vocal</span></div>' +
    '<div class="stat"><b>' + pct(n.rate) + '</b><span>répondent SANS vocal</span></div>' +
    '<div class="stat ' + (ab.diffPts > 0 ? "ok" : ab.diffPts < 0 ? "ko" : "") + '"><b>' + (ab.diffPts == null ? "–" : sign(Math.round(ab.diffPts)) + " pts") + '</b><span>écart' + (ab.ratio ? " (×" + ab.ratio.toFixed(1).replace(".0", "") + ")" : "") + '</span></div>' +
    '<div class="stat ' + (conf >= 95 ? "ok" : conf >= 80 ? "warn" : "") + '"><b>' + (conf == null ? "–" : conf + " %") + '</b><span>confiance que l’écart est réel<div class="bar"><div style="width:' + (conf || 0) + '%;background:' + (conf >= 95 ? "var(--ok)" : "var(--warn)") + '"></div></div></span></div>';
  const row = (label, a, b) => "<tr><td>" + label + "</td><td>" + a + "</td><td>" + b + "</td></tr>";
  const share = (k, g) => g.done ? "<b>" + g[k] + "</b> <span class=hint>(" + Math.round(g[k] / g.done * 100) + " %)</span>" : "–";
  $("#abTable").innerHTML = "<thead><tr><th></th><th>🎙️ Avec vocal</th><th>🚫 Sans vocal</th></tr></thead><tbody>" +
    row("Fans terminés (48 h passées)", "<b>" + v.done + "</b>", "<b>" + n.done + "</b>") +
    row("Ont répondu", share("replied", v), share("replied", n)) +
    row("… en moins d’1 h", share("within1h", v), share("within1h", n)) +
    row("… en moins de 24 h", share("within24h", v), share("within24h", n)) +
    row("Délai médian avant la réponse", mins(v.medianMin), mins(n.medianMin)) +
    row("Encore dans les 48 h (dont déjà répondu)", v.pending + " (" + v.pendingReplied + ")", n.pending + " (" + n.pendingReplied + ")") +
    "</tbody><tfoot>" + row("Reply rate global, tous fans confondus", "<b>" + pct(ab.all.rate) + "</b> <span class=hint>(" + ab.all.replied + " / " + ab.all.done + ")</span>", "") + "</tfoot>";
  const since = ab.since ? "Depuis le " + new Date(ab.since).toLocaleDateString("fr-FR") + ". " : "";
  let verdict;
  if (!v.done && !n.done) verdict = "Aucun fan n’a encore fini ses 48 h.";
  else if (ab.significant === true) verdict = v.rate > n.rate ? "✅ Le vocal fait répondre plus de fans : écart fiable." : "❌ Le vocal ne fait pas mieux (voire moins bien) : écart fiable.";
  else if (ab.significant === false) verdict = "Pas d’écart fiable entre les deux groupes avec " + Math.min(v.done, n.done) + " fans par groupe" + (ab.needPerGroup ? " : encore ~" + ab.needPerGroup + " fans par groupe pour trancher." : ".");
  else verdict = "Trop tôt pour conclure : encore ~" + ab.needPerGroup + " fans terminés par groupe (minimum 30).";
  $("#abHint").textContent = since + verdict + (ab.excluded ? " · " + ab.excluded + " fan(s) hors test (vocal pas parti)." : "");
}

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

// ── Selfie avec le prénom ──
const sfFields = { x: "#sfX", y: "#sfY", angle: "#sfAngle", size: "#sfSize", maxWidth: "#sfMaxW", prompt: "#sfPrompt", mode: "#sfMode" };
async function loadSelfie() {
  let d; try { d = await call("selfieLoad"); } catch { return; }
  const s = d.settings;
  $("#sfEnabled").checked = s.enabled; $("#sfFallback").checked = s.fallback;
  $("#sfLabel").textContent = s.enabled ? "Selfie : ACTIF" : "Selfie : arrêté";
  for (const k in sfFields) if (document.activeElement !== $(sfFields[k])) $(sfFields[k]).value = s[k];
  for (const i of zoneInputs()) { const [p, c] = i.dataset.z.split(",").map(Number); if (document.activeElement !== i) i.value = s.zone[p][c]; }
  $("#sfPhotoState").innerHTML = d.hasPhoto ? "✓ Photo installée" : '<span class="ko">Aucune photo : choisis le selfie et clique « Installer ».</span>';
}
const zoneInputs = () => [...document.querySelectorAll("[data-z]")];
const readSelfie = () => {
  const o = { enabled: $("#sfEnabled").checked, fallback: $("#sfFallback").checked, zone: [[0, 0], [0, 0], [0, 0], [0, 0]] };
  for (const k in sfFields) o[k] = $(sfFields[k]).value;
  for (const i of zoneInputs()) { const [p, c] = i.dataset.z.split(",").map(Number); o.zone[p][c] = Number(i.value); }
  return o;
};
$("#sfZone").onclick = async (e) => {
  e.target.disabled = true; say($("#sfMsg"), "Aperçu de la zone…", true);
  try { const r = await call("selfieZone", { settings: readSelfie() }); say($("#sfMsg"), "Le prénom sera écrit dans le cadre rouge.", true); $("#sfOut").innerHTML = '<img src="data:image/jpeg;base64,' + r.image + '" style="max-width:100%;max-height:70vh;border-radius:10px">'; }
  catch (err) { say($("#sfMsg"), err.message, false); }
  e.target.disabled = false;
};
$("#sfEnabled").onchange = async (e) => { e.target.disabled = true; try { await call("selfieSave", { settings: { enabled: e.target.checked } }); } catch (err) { alert(err.message); } await loadSelfie(); e.target.disabled = false; };
$("#sfSave").onclick = async (e) => {
  e.target.disabled = true;
  try { await call("selfieSave", { settings: readSelfie() }); say($("#sfMsg"), "Enregistré ✓", true); loadSelfie(); } catch (err) { say($("#sfMsg"), err.message, false); }
  e.target.disabled = false;
};
$("#sfUpload").onclick = async (e) => {
  const f = $("#sfFile").files[0];
  if (!f) return say($("#sfMsg"), "Choisis d'abord la photo.", false);
  if (f.size > 8 * 1024 * 1024) return say($("#sfMsg"), "Photo trop lourde (max 8 Mo).", false);
  e.target.disabled = true; say($("#sfMsg"), "Envoi de la photo…", true);
  try { const r = await call("selfiePhoto", { image: await fileB64(f) }); say($("#sfMsg"), "Photo installée ✓ (" + Math.round(r.bytes / 1024) + " Ko). Essaie avec un pseudo.", true); loadSelfie(); }
  catch (err) { say($("#sfMsg"), err.message, false); }
  e.target.disabled = false;
};
$("#sfTest").onclick = async (e) => {
  const pseudo = $("#sfPseudo").value.trim();
  if (!pseudo) return say($("#sfMsg"), "Écris un pseudo.", false);
  e.target.disabled = true; say($("#sfMsg"), "Fabrication du selfie… (jusqu'à 30 s avec l'IA)", true); $("#sfOut").innerHTML = "";
  try {
    await call("selfieSave", { settings: readSelfie() });
    const r = await call("selfieTest", { pseudo, mode: $("#sfMode").value });
    if (!r.image) say($("#sfMsg"), "Pseudo illisible → pas de selfie.", true);
    else {
      say($("#sfMsg"), "Prénom : " + r.name + " · méthode : " + (r.how === "ai" ? "IA" : "texte posé") + (r.aiError ? " (IA en échec : " + r.aiError + ")" : ""), r.aiError ? "warn" : true);
      $("#sfOut").innerHTML = '<img src="data:image/jpeg;base64,' + r.image + '" style="max-width:100%;max-height:70vh;border-radius:10px">';
    }
  } catch (err) { say($("#sfMsg"), err.message, false); }
  e.target.disabled = false;
};
$("#sfPseudo").onkeydown = (e) => { if (e.key === "Enter") $("#sfTest").click(); };

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
const TAG = { sent: "Envoyé", late: "Trop tard", error: "Échec", control: "Sans vocal (test)" };

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
    <td><span class="tag \${st}">\${TAG[st]}</span>\${l.selfie ? ' <span class="hint">+ selfie ' + (l.selfie === "ai" ? "IA" : "texte") + '</span>' : ""}\${detail ? '<div class="hint">' + detail + "</div>" : ""}\${l.selfieError ? '<div class="hint">selfie : ' + esc(l.selfieError) + "</div>" : ""}</td>
    <td>\${st === "sent" ? "" : '<button class="sm" data-retry="' + i + '">' + (st === "control" ? "Envoyer quand même" : "Renvoyer") + '</button>'}</td></tr>\`;
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
  $("#abEnabled").checked = s.abEnabled; renderAb(d.ab, s.abEnabled);
  $("#toggle").textContent = s.enabled ? "⏻ ON → couper" : "⏻ OFF → activer";
  $("#toggle").className = "main " + (s.enabled ? "on" : "off");
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
  loadSelfie();
}
load();
</script>
</body>
</html>`;
