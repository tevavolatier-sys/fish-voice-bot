// Tests du contrôle de la mise en scène Drama 3 (mots inchangés, balises valides).
// Usage :  npx tsx scripts/test-enrich.ts
import assert from "node:assert/strict";
import { checkDirected, spokenWords } from "../lib/enrich.js";
import { directionView, visibleLength } from "../lib/direction-view.js";
import { speakable } from "../lib/speakable.js";

const input = "Coucou toi, tu m’as manqué aujourd’hui 😘 j’arrêtais pas de penser à ⟦T0⟧";

// Bonne mise en scène : acceptée, emoji retiré
const good = checkDirected(
  input,
  "[smiling, soft] Coucou toi… [soft breath] tu m'as manqué aujourd'hui, [shy] j'arrêtais pas de <soft>penser à ⟦T0⟧</soft>."
);
assert.ok(good);
assert.ok(!/😘/.test(good!));

// Mot ajouté → refusé
assert.equal(
  checkDirected(input, "[smiling] Coucou toi, tu m'as tellement manqué aujourd'hui j'arrêtais pas de penser à ⟦T0⟧"),
  null
);
// Jeton perdu → refusé
assert.equal(checkDirected(input, "Coucou toi, tu m'as manqué aujourd'hui j'arrêtais pas de penser à toi"), null);
// Balise mal fermée / inconnue / imbriquée → refusée
assert.equal(checkDirected(input, "<whisper>Coucou</soft> toi tu m'as manqué aujourd'hui j'arrêtais pas de penser à ⟦T0⟧"), null);
assert.equal(checkDirected(input, "<sexy>Coucou</sexy> toi tu m'as manqué aujourd'hui j'arrêtais pas de penser à ⟦T0⟧"), null);
assert.equal(checkDirected(input, "<whisper><soft>Coucou</soft></whisper> toi tu m'as manqué aujourd'hui j'arrêtais pas de penser à ⟦T0⟧"), null);
// Direction trop longue → refusée
assert.equal(
  checkDirected(input, "[she is smiling a lot because she really really misses him so much today] Coucou toi tu m'as manqué aujourd'hui j'arrêtais pas de penser à ⟦T0⟧"),
  null
);
// Ponctuation libre, apostrophes différentes : mêmes mots
assert.deepEqual(spokenWords("J’ai envie… de toi !"), spokenWords("[breathy] j'ai envie, de toi"));
// Guillemets / bloc de code autour de la réponse : nettoyés
assert.ok(checkDirected("salut toi", "```\n[warm] Salut toi…\n```"));

// 🌶🌶 : gémissements ajoutés (« ahh », « mmh ») acceptés, vrais mots ajoutés refusés
const hot = "Oh oui, continue, plus fort";
assert.ok(checkDirected(hot, "[moaning loudly] Oh oui… [loud moan] ahh… continue, mmh… <forceful>plus fort</forceful>", 2));
assert.equal(checkDirected(hot, "[moaning] Oh oui, continue, encore plus fort", 2), null);

// Aperçu visuel : directions en italique, sons en emojis, chuchoté souligné, HTML échappé
const v = directionView("[smiling, soft] Coucou <toi>… [soft breath] [loud moan] <whisper>viens</whisper> [short pause] & là");
assert.ok(v.includes("🎬<i>smiling, soft</i>"));
assert.ok(v.includes("💨") && v.includes("🥵") && v.includes("⏸"));
assert.ok(v.includes("🤫<u>viens</u>"));
assert.ok(v.includes("&amp;"));
assert.ok(visibleLength(v) < v.length);

// SMS → mots prononçables
assert.equal(speakable("tkt jsp mdr, cc toi 😂", "fr"), "t'inquiète je sais pas haha, coucou toi haha");
assert.equal(speakable("Stp viens trooooop vite!!!", "fr"), "S'il te plaît viens trooop vite!");
assert.equal(speakable("omg u r so cute lol", "en"), "oh my god you r so cute haha");
assert.equal(speakable("Ptdr t'es bête", "fr"), "haha t'es bête");

console.log("tests mise en scène : OK");
