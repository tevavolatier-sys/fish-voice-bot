// Enrichissement automatique du texte avec des tags d'émotion Fish Audio
// via l'API Claude. En cas d'échec ou d'absence de clé, le texte brut est
// utilisé tel quel : la génération vocale n'est jamais bloquée.

import Anthropic from "@anthropic-ai/sdk";

/** Détecte un tag déjà présent, ex. [whisper] — dans ce cas on ne touche à rien */
const EXISTING_TAG = /\[[a-zA-Z][a-zA-Z ]{0,25}\]/;

const SYSTEM_PROMPT = `Tu prépares des textes pour une synthèse vocale Fish Audio. Ce sont des messages vocaux chaleureux, séduisants ou complices envoyés par une femme à un admirateur.

Ta seule tâche : insérer des tags d'émotion entre crochets aux endroits naturels du texte pour rendre la voix vivante et crédible.

Tags autorisés (uniquement ceux-là) :
[excited] [whisper] [sad] [angry] [surprised] [nervous]
[laughing] [chuckling] [sighing] [crying] [breath]
[soft tone] [shouting] [in a hurry tone]

Règles strictes :
- Ne modifie JAMAIS les mots du texte : aucun mot ajouté, supprimé ou corrigé, ponctuation conservée.
- Insère 1 à 3 tags maximum, seulement là où ils renforcent naturellement l'émotion.
- Un tag se place juste avant la phrase ou le groupe de mots qu'il colore.
- Si le texte est neutre et court, un seul tag suffit (souvent [soft tone] ou [breath]).
- Réponds UNIQUEMENT avec le texte final taggé, sans explication, sans guillemets.`;

/**
 * Ajoute automatiquement des tags d'émotion au texte.
 * Retourne le texte d'origine si :
 * - ANTHROPIC_API_KEY n'est pas configurée
 * - le texte contient déjà des tags (l'opérateur les a mis lui-même)
 * - l'appel à l'API Claude échoue ou dépasse le délai
 */
export async function enrichWithEmotionTags(text: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return text;
  if (EXISTING_TAG.test(text)) return text;

  try {
    const client = new Anthropic({ apiKey, timeout: 10_000, maxRetries: 1 });
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    });

    const enriched = response.content
      .find((block) => block.type === "text")
      ?.text.trim();

    // Garde-fou : si la réponse est vide ou aberrante (trop courte/longue
    // par rapport à l'original), on garde le texte brut.
    if (!enriched || enriched.length < text.length * 0.8) return text;
    if (enriched.length > text.length + 150) return text;

    return enriched;
  } catch (err) {
    console.error("Enrichissement LLM échoué, texte brut utilisé:", err);
    return text;
  }
}
