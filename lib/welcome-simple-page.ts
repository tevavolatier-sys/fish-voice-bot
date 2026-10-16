// Page simple de l'interface bienvenue (Teva, 15/10 : « trop compliqué ») :
// modèle, ON/OFF, tester un prénom, résultat du test. Tout le reste : « Réglages avancés » (?avance=1).
export const SIMPLE_PAGE = /* html */ `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vocal de bienvenue</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1b20;--mute:#77727c;--line:#e4e1dc;--on:#1f8a4c;--off:#b3261e;--acc:#5b3a8c}
@media (prefers-color-scheme:dark){:root{--bg:#141216;--card:#1e1b21;--ink:#eee9f2;--mute:#9a94a1;--line:#332f38;--acc:#b493e6}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,sans-serif}
main{max-width:520px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:20px;margin:0 0 18px}
.tabs{display:flex;gap:8px;margin-bottom:16px}
.tabs button{flex:1;padding:12px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:12px;font-size:16px;cursor:pointer}
.tabs button.cur{border-color:var(--acc);box-shadow:0 0 0 2px var(--acc) inset;font-weight:600}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-left:6px;background:var(--off)}.dot.on{background:var(--on)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
.row{display:flex;gap:8px;align-items:center}
input{flex:1;min-width:0;padding:12px;border:1px solid var(--line);border-radius:10px;font-size:16px;background:var(--bg);color:var(--ink)}
.btn{padding:12px 16px;border:0;border-radius:10px;background:var(--acc);color:#fff;font-size:16px;cursor:pointer;white-space:nowrap}
.btn:disabled{opacity:.5}
.toggle{width:100%;padding:16px;border:0;border-radius:12px;font-size:18px;font-weight:600;color:#fff;cursor:pointer}
.mute{color:var(--mute);font-size:14px}audio{width:100%;margin-top:12px}
a{color:var(--acc)}
</style></head><body><main>
<h1>Vocal de bienvenue</h1>
<div id="login" class="card" hidden><div class="row"><input id="pw" type="password" placeholder="Mot de passe"><button class="btn" id="go">OK</button></div></div>
<div id="app" hidden>
  <div class="tabs" id="tabs"></div>
  <div class="card">
    <button class="toggle" id="toggle">…</button>
    <p class="mute" id="state" style="margin:10px 0 0"></p>
  </div>
  <div class="card">
    <b>Tester</b>
    <p class="mute" style="margin:4px 0 10px">Tape un prénom ou un pseudo de fan, puis écoute. Rien n'est envoyé.</p>
    <div class="row"><input id="name" placeholder="ex. Mike ou mike_2595xx"><button class="btn" id="play">▶ Écouter</button></div>
    <div id="out"></div>
  </div>
  <a class="btn" href="?stats=1" style="display:block;text-align:center;text-decoration:none;margin-bottom:14px">📊 Statistiques (tous les tests, avec graphiques)</a>
  <div class="card"><b>Résultat du test</b><p class="mute" id="ab" style="margin:6px 0 0">…</p></div>
  <p class="mute">Crédits OnlyFansAPI aujourd'hui : <span id="cred">…</span> · <a href="?avance=1">Réglages avancés</a></p>
</div>
</main>
<script>
const $=(s)=>document.querySelector(s);
let KEY="",ACCT="sienna",DATA=null;
try{KEY=localStorage.getItem("welcomeKey")||"";ACCT=localStorage.getItem("welcomeAccount")||"sienna"}catch{}
async function call(action,data={}){
  const r=await fetch(location.pathname,{method:"POST",headers:{"Content-Type":"application/json","x-admin-key":KEY},body:JSON.stringify({action,account:ACCT,...data})});
  const j=await r.json().catch(()=>({ok:false,error:"Réponse illisible"}));
  if(r.status===401){$("#login").hidden=false;$("#app").hidden=true;throw new Error(j.error||"Mot de passe")}
  if(!j.ok)throw new Error(j.error||"Erreur");return j;
}
const pct=(x)=>x==null?"–":Math.round(x*100)+" %";
function render(){
  const d=DATA,s=d.settings;
  $("#tabs").innerHTML=d.accounts.map(a=>'<button data-k="'+a.key+'" class="'+(a.key===ACCT?"cur":"")+'">'+a.modelName+'<span class="dot '+(a.enabled?"on":"")+'"></span></button>').join("");
  document.querySelectorAll("#tabs button").forEach(b=>b.onclick=()=>{ACCT=b.dataset.k;try{localStorage.setItem("welcomeAccount",ACCT)}catch{}$("#out").innerHTML="";load()});
  const t=$("#toggle");t.textContent=s.enabled?"ON — les nouveaux abonnés reçoivent le vocal":"OFF — rien n'est envoyé";t.style.background=s.enabled?"var(--on)":"var(--off)";
  $("#state").textContent=s.abEnabled?(d.abCurrent==="v90"?"9 fans sur 10 reçoivent le vocal, 1 sur 10 rien (pour mesurer).":"Test A/B en cours."):"Tous les nouveaux abonnés reçoivent le vocal.";
  const ab=d.ab;
  $("#ab").textContent=!ab||!(ab.voice.done+ab.none.done)?"Pas encore de données.":"Ont répondu : "+pct(ab.voice.rate)+" avec vocal ("+ab.voice.done+" fans) contre "+pct(ab.none.rate)+" sans ("+ab.none.done+" fans)."+(ab.significant?" Écart fiable.":" Pas encore assez de fans pour conclure.");
  $("#cred").textContent=d.credits?d.credits.today+" / "+d.credits.cap:"–";
}
async function load(){try{DATA=await call("load");$("#login").hidden=true;$("#app").hidden=false;render()}catch(e){if($("#login").hidden)alert(e.message)}}
$("#go").onclick=()=>{KEY=$("#pw").value;try{localStorage.setItem("welcomeKey",KEY)}catch{}load()};
$("#toggle").onclick=async()=>{
  const on=!DATA.settings.enabled,name=DATA.account.modelName;
  if(on&&!confirm("Mettre "+name+" sur ON ? Les vrais nouveaux abonnés recevront le vocal."))return;
  try{await call("save",{settings:{enabled:on}});load()}catch(e){alert(e.message)}
};
$("#play").onclick=async()=>{
  const v=$("#name").value.trim();if(!v){$("#name").focus();return}
  const b=$("#play");b.disabled=true;b.textContent="…";$("#out").innerHTML='<p class="mute">Fabrication du vocal (10 à 30 s)…</p>';
  try{const r=await call("test",{pseudo:v});$("#out").innerHTML='<p class="mute">Prénom compris : <b>'+(r.name||"illisible")+'</b></p><audio controls autoplay src="data:audio/mpeg;base64,'+r.audio+'"></audio>'}
  catch(e){$("#out").innerHTML='<p style="color:var(--off)">'+e.message+'</p>'}
  b.disabled=false;b.textContent="▶ Écouter";
};
$("#name").addEventListener("keydown",e=>{if(e.key==="Enter")$("#play").click()});
if(KEY)load();else $("#login").hidden=false;
</script></body></html>`;
