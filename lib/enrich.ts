// Enrichissement automatique du texte avec des tags d'émotion Fish Audio.
// Fournisseur LLM par ordre de priorité :
//   1. Google Gemini (GEMINI_API_KEY) — GRATUIT, clé via aistudio.google.com
//   2. Groq (GROQ_API_KEY) — GRATUIT, Llama 3.3 70B, très rapide
//   3. Claude (ANTHROPIC_API_KEY) — payant, léger coût par message
//   4. Aucun -> le texte brut est utilisé tel quel
// En cas d'échec quel qu'il soit, la génération vocale n'est jamais bloquée.

import Anthropic from "@anthropic-ai/sdk";

/** Détecte un tag déjà présent, ex. [whispering] — dans ce cas on ne touche à rien */
const EXISTING_TAG = /\[[a-zA-Z][a-zA-Z -]{0,25}\]/;

const TIMEOUT_MS = 10_000;

const SYSTEM_PROMPT = `Tu prépares des textes pour une synthèse vocale Fish Audio. Ce sont des messages vocaux chaleureux, séduisants ou complices envoyés par une femme à un admirateur.

Ta seule tâche : insérer des tags d'émotion entre crochets aux endroits naturels du texte pour rendre la voix vivante et crédible.

Tags autorisés (uniquement ceux-là) :
- Émotions positives : [excited] [delighted] [joyful] [satisfied] [proud] [confident] [relaxed] [grateful] [moved] [amused] [curious] [interested]
- Émotions négatives : [sad] [unhappy] [upset] [depressed] [worried] [anxious] [nervous] [scared] [panicked] [angry] [furious] [frustrated] [impatient] [guilty] [embarrassed] [awkward] [hesitating]
- Autres émotions : [surprised] [astonished] [confused] [serious] [sincere] [comforting] [empathetic] [sarcastic]
- Façons de parler : [whispering] [soft tone] [shouting] [screaming] [in a hurry tone]
- Sons et respirations : [laughing] [chuckling] [giggling] [sobbing] [crying loudly] [sighing] [breath] [panting] [groaning] [cough] [lip-smacking]
- Pauses : [break] [long-break]

Règles strictes :
- Ne modifie JAMAIS les mots du texte : aucun mot ajouté, supprimé ou corrigé, ponctuation conservée.
- Insère 1 à 4 tags maximum, seulement là où ils renforcent naturellement l'émotion.
- Un tag se place juste avant la phrase ou le groupe de mots qu'il colore.
- Les pauses [break] sont utiles avant un changement de ton ou une confidence.
- Si le texte est neutre et court, un seul tag suffit (souvent [soft tone] ou [breath]).
- Réponds UNIQUEMENT avec le texte final taggé, sans explication, sans guillemets.`;

/** Nom du fournisseur actif (pour le diagnostic) */
export function enrichProvider(): "gemini" | "groq" | "claude" | "aucun" {
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.GROQ_API_KEY) return "groq";
  if (process.env.ANTHROPIC_API_KEY) return "claude";
  return "aucun";
}

async function enrichWithGemini(text: string, apiKey: string): Promise<string | null> {
  const model = "gemini-2.5-flash-lite";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
        // Textes séduisants : on désactive les filtres pour éviter les blocages
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
  );
  if (!res.ok) {
    console.error(`Gemini ${res.status}:`, await res.text().catch(() => ""));
    return null;
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const parts = data.candidates?.[0]?.content?.parts;
  const out = parts?.map((p) => p.text ?? "").join("").trim();
  return out || null;
}

async function enrichWithGroq(text: string, apiKey: string): Promise<string | null> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1024,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    console.error(`Groq ${res.status}:`, await res.text().catch(() => ""));
    return null;
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content?.trim() ?? null;
}

async function enrichWithClaude(text: string, apiKey: string): Promise<string | null> {
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: text }],
  });
  return (
    response.content.find((block) => block.type === "text")?.text.trim() ?? null
  );
}

/**
 * Ajoute automatiquement des tags d'émotion au texte.
 * Retourne le texte d'origine si :
 * - aucune clé LLM n'est configurée
 * - le texte contient déjà des tags (l'opérateur les a mis lui-même)
 * - l'appel au LLM échoue, dépasse le délai ou renvoie un résultat aberrant
 */
export async function enrichWithEmotionTags(text: string): Promise<string> {
  if (EXISTING_TAG.test(text)) return text;

  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!geminiKey && !groqKey && !anthropicKey) return text;

  try {
    const enriched = geminiKey
      ? await enrichWithGemini(text, geminiKey)
      : groqKey
        ? await enrichWithGroq(text, groqKey)
        : await enrichWithClaude(text, anthropicKey!);

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
