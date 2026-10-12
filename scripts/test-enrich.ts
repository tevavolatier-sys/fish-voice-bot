// Tests du contrôle de la mise en scène Drama 3 (mots inchangés, balises valides).
// Usage :  npx tsx scripts/test-enrich.ts
import assert from "node:assert/strict";
import { checkDirected, spokenWords } from "../lib/enrich.js";

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

console.log("tests mise en scène : OK");
