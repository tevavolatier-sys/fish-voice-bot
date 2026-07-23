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

/** Intensity levels picked by the operator via /level (default: 1) */
export const INTENSITY_LEVELS: Record<number, { label: string; instruction: string }> = {
  0: {
    label: "😇 Normal",
    instruction:
      "INTENSITY LEVEL: NORMAL — NO SEXUALIZATION AT ALL. The message must sound friendly, warm or neutral. " +
      "Use only simple emotion tags ([soft tone], [breath], [chuckling], emotions matching the text). " +
      "FORBIDDEN: [panting], [groaning], [whispering] and any sensual effect. " +
      "1 to 3 tags max, discreet breathing.",
  },
  1: {
    label: "🌶️ Light",
    instruction:
      "INTENSITY LEVEL: LIGHT FLIRTING (1/3). Charming but soft tone: [soft tone], a few [breath], " +
      "a playful [chuckling] or [giggling]. No panting, no moaning. 2 to 4 tags.",
  },
  2: {
    label: "🌶️🌶️ Hot",
    instruction:
      "INTENSITY LEVEL: SENSUAL (2/3). Intimate voice: [whispering] and [soft tone] on confessions, " +
      "marked breathing with several [breath], some [sighing], and [break] pauses to build tension. " +
      "3 to 6 tags.",
  },
  3: {
    label: "🌶️🌶️🌶️ Very hot",
    instruction:
      "INTENSITY LEVEL: VERY SENSUAL (3/3). Maximum breath and moaning: multiply [breath] everywhere, " +
      "add [panting] and [groaning] (moaning) on the exciting parts, some [sighing], " +
      "[whispering] on almost every sentence, and [break] or [long-break] pauses to build desire. " +
      "5 to 8 tags.",
  },
};

export const DEFAULT_INTENSITY = 1;

function buildSystemPrompt(level: number): string {
  const intensity =
    INTENSITY_LEVELS[level]?.instruction ??
    INTENSITY_LEVELS[DEFAULT_INTENSITY].instruction;

  return `You prepare texts for Fish Audio voice synthesis. These are warm, flirty or intimate voice messages sent by a woman to an admirer.

Your only task: insert emotion tags in brackets at natural spots in the text to make the voice feel alive and believable.

Allowed tags (only these):
- Positive emotions: [excited] [delighted] [joyful] [satisfied] [proud] [confident] [relaxed] [grateful] [moved] [amused] [curious] [interested]
- Negative emotions: [sad] [unhappy] [upset] [depressed] [worried] [anxious] [nervous] [scared] [panicked] [angry] [furious] [frustrated] [impatient] [guilty] [embarrassed] [awkward] [hesitating]
- Other emotions: [surprised] [astonished] [confused] [serious] [sincere] [comforting] [empathetic] [sarcastic]
- Speaking styles: [whispering] [soft tone] [shouting] [screaming] [in a hurry tone]
- Sounds and breathing: [laughing] [chuckling] [giggling] [sobbing] [crying loudly] [sighing] [breath] [panting] [groaning] [cough] [lip-smacking]
- Pauses: [break] [long-break]

${intensity}

Strict rules:
- NEVER change the words of the text: no word added, removed or corrected, punctuation preserved.
- A tag goes right before the sentence or group of words it colors.
- BREATHING: a voice that breathes is a believable voice. Place [breath] where a real person would catch their breath.
- STRICTLY respect the requested intensity level above, even if the text seems more or less sexual than the level.
- Reply ONLY with the final tagged text, no explanation, no quotes.`;
}

/** Nom du fournisseur actif (pour le diagnostic) */
export function enrichProvider(): "gemini" | "groq" | "claude" | "aucun" {
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.GROQ_API_KEY) return "groq";
  if (process.env.ANTHROPIC_API_KEY) return "claude";
  return "aucun";
}

async function enrichWithGemini(
  text: string,
  apiKey: string,
  systemPrompt: string,
  variety = false
): Promise<string | null> {
  // Alias "latest" : suit automatiquement le dernier modèle flash-lite,
  // évite les erreurs 404 quand Google retire un ancien modèle.
  const model = "gemini-flash-lite-latest";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text }] }],
        // variety = « nouvelles émotions » : température haute pour varier les tags
        generationConfig: { temperature: variety ? 1.1 : 0.3, maxOutputTokens: 1024 },
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

async function enrichWithGroq(
  text: string,
  apiKey: string,
  systemPrompt: string
): Promise<string | null> {
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
        { role: "system", content: systemPrompt },
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

async function enrichWithClaude(
  text: string,
  apiKey: string,
  systemPrompt: string
): Promise<string | null> {
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: "user", content: text }],
  });
  return (
    response.content.find((block) => block.type === "text")?.text.trim() ?? null
  );
}

/**
 * Ajoute automatiquement des tags d'émotion au texte, selon le niveau
 * d'intensité choisi par l'opérateur (0 à 3).
 * Retourne le texte d'origine si :
 * - aucune clé LLM n'est configurée
 * - le texte contient déjà des tags (l'opérateur les a mis lui-même)
 * - l'appel au LLM échoue, dépasse le délai ou renvoie un résultat aberrant
 */
export async function enrichWithEmotionTags(
  text: string,
  level: number = DEFAULT_INTENSITY,
  variety = false
): Promise<string> {
  if (EXISTING_TAG.test(text)) return text;

  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!geminiKey && !groqKey && !anthropicKey) return text;

  const systemPrompt = buildSystemPrompt(level);

  try {
    const enriched = geminiKey
      ? await enrichWithGemini(text, geminiKey, systemPrompt, variety)
      : groqKey
        ? await enrichWithGroq(text, groqKey, systemPrompt)
        : await enrichWithClaude(text, anthropicKey!, systemPrompt);

    // Garde-fou : si la réponse est vide ou aberrante (trop courte/longue
    // par rapport à l'original), on garde le texte brut.
    if (!enriched || enriched.length < text.length * 0.8) return text;
    if (enriched.length > text.length + 300) return text;

    return enriched;
  } catch (err) {
    console.error("Enrichissement LLM échoué, texte brut utilisé:", err);
    return text;
  }
}
