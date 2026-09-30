// Enrichissement automatique du texte avec des tags d'émotion Fish Audio.
// Fournisseur LLM par ordre de priorité :
//   1. Google Gemini (GEMINI_API_KEY) — GRATUIT, clé via aistudio.google.com
//   2. Groq (GROQ_API_KEY) — GRATUIT, Llama 3.3 70B, très rapide
//   3. Claude (ANTHROPIC_API_KEY) — payant, léger coût par message
//   4. Aucun -> le texte brut est utilisé tel quel
// En cas d'échec quel qu'il soit, la génération vocale n'est jamais bloquée.

import Anthropic from "@anthropic-ai/sdk";
import { LEFTOVER, maskSensitiveEn, maskSensitiveFr, unmask } from "./translate.js";

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

// ── 3 styles d'interprétation ─────────────────────────────────
// Le bot sort 3 versions de chaque vocal : même texte, lecture différente.
// Chaque style pousse le LLM vers un placement de tags distinct.
export const VOICE_STYLES: { key: string; label: string; instruction: string }[] = [
  {
    key: "soft",
    label: "🌙 Soft",
    instruction:
      "READING STYLE: SOFT & INTIMATE. Slow, close to the mic. Favor [whispering], [soft tone], gentle [breath], a [break] before the key phrase. Few or no laughs. Rhythm: slow — long \"...\" suspensions, one soft em dash before the confession.",
  },
  {
    key: "playful",
    label: "✨ Playful",
    instruction:
      "READING STYLE: PLAYFUL & TEASING. Lively, smiling voice. Favor [giggling], [chuckling], [amused], [excited], quick [breath]; light teasing pauses [break]. Less whispering. Rhythm: bouncy — short chunks, a playful \"?\" or \"!\", a teasing dash before the punchline.",
  },
  {
    key: "intense",
    label: "🔥 Intense",
    instruction:
      "READING STYLE: INTENSE & URGENT. Heavier breathing, more [breath] and [sighing], [panting] if the intensity level allows it, [whispering] on the most intimate words, a [long-break] to build tension. Confident, direct. Rhythm: urgent — em dashes that cut the sentence, a repeated key word if present, a hard \"...\" before the climax.",
  },
];


function buildSystemPrompt(level: number, style?: string): string {
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
${style ? style + "\n" : ""}
Strict rules:
- NEVER change the WORDS of the text: no word added, removed or corrected.
- RHYTHM (very important — the voice sounds flat without it): you MAY and SHOULD reshape the punctuation so it sounds like a real spoken voice note, not a read text:
  • use an em dash " — " where she would pause mid-sentence or hold back ("je te jure — détruis-moi")
  • use "..." for suspense or trailing off, and break long sentences into shorter spoken chunks with commas or periods
  • end a teasing line with "?" or "!" when that matches the intent; a hesitation can become "..."
  • repeat the key word ONLY if it is already in the text; never invent words
  Goal: 2 to 4 rhythm marks (— or ...) per message, placed where a real woman would breathe, tease or hesitate.
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
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  };
  const cand = data.candidates?.[0];
  const out = cand?.content?.parts?.map((p) => p.text ?? "").join("").trim();
  if (!out && cand?.finishReason) console.error(`Gemini enrich refus: ${cand.finishReason}`);
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
  variety = false,
  styleKey?: string
): Promise<string> {
  if (EXISTING_TAG.test(text)) return text;

  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!geminiKey && !groqKey && !anthropicKey) return text;

  const styleInstruction = VOICE_STYLES.find((v) => v.key === styleKey)?.instruction;
  const systemPrompt =
    buildSystemPrompt(level, styleInstruction) +
    "\n- Some words are replaced by placeholder tokens like ⟦T0⟧: keep every token EXACTLY as written, in place. Never remove or alter a token.";

  // Gemini REFUSE les textes explicites (PROHIBITED_CONTENT) → sans tags.
  // Même parade que la traduction : les mots sensibles (FR + EN) deviennent
  // des jetons neutres avant l'appel, remis à l'identique après. On tente
  // masqué d'abord (2×), puis brut en dernier recours.
  const maskFr = maskSensitiveFr(text);
  const maskBoth = maskSensitiveEn(maskFr.masked);
  const table = new Map([...maskFr.table, ...maskBoth.table]);
  const masked = maskBoth.masked;
  const attempts: [string, boolean][] = [
    [masked, variety],
    [masked, true],
    [text, variety],
  ];

  const accept = (enriched: string | null, ref: string): string | null => {
    // Garde-fou : réponse vide ou aberrante (trop courte/longue) → refusée
    if (!enriched || enriched.length < ref.length * 0.8) return null;
    if (enriched.length > ref.length + 300) return null;
    return enriched;
  };

  for (const [input, vary] of attempts) {
    try {
      const raw = geminiKey
        ? await enrichWithGemini(input, geminiKey, systemPrompt, vary)
        : groqKey
          ? await enrichWithGroq(input, groqKey, systemPrompt)
          : await enrichWithClaude(input, anthropicKey!, systemPrompt);
      const enriched = accept(raw, input);
      if (!enriched) {
        console.error("Enrich rejeté (longueur/vide):", JSON.stringify({ input, raw }));
        continue;
      }
      const restored = input === masked ? unmask(enriched, table) : enriched;
      if (LEFTOVER.test(restored)) {
        console.error("Enrich rejeté (jeton perdu):", JSON.stringify({ restored }));
        continue; // un jeton a été mangé → essai suivant
      }
      return restored;
    } catch (err) {
      console.error("Enrichissement LLM échoué (essai suivant):", err);
    }
  }
  console.error("Enrichissement impossible après 3 essais, texte brut utilisé");
  return text;
}
