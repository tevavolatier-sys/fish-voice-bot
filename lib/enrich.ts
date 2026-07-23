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

/**
 * Ambiances choisies PAR BOUTON par l'opérateur avant chaque vocal.
 * `auto` = le LLM lit le texte et choisit lui-même (comportement historique).
 * Chaque instruction pilote l'intonation au niveau du MOT (tags ciblés +
 * sculpture légère : étirements, « mmh », « ... », virgules).
 */
export const MOODS: Record<string, { label: string; instruction: string | null }> = {
  auto: { label: "🎲 Auto", instruction: null },
  sweet: {
    label: "🥰 Sweet",
    instruction:
      "MOOD PICKED BY THE OPERATOR: SWEET & LOVING — warm, tender, affectionate. " +
      "[soft tone] on tender confessions, gentle [breath] between phrases, maybe [moved] or a soft [giggling]. " +
      "Stretch the affectionate key words (« soooo sweet », « miss youuuu »).",
  },
  playful: {
    label: "😏 Playful",
    instruction:
      "MOOD PICKED BY THE OPERATOR: PLAYFUL & TEASING — mischievous, flirty-funny. " +
      "[amused] tone, [chuckling] or [giggling] on the jokes, a teasing « ... » right before the punchline, " +
      "[curious] on the questions. Light and bouncy delivery.",
  },
  hot: {
    label: "🔥 Hot",
    instruction:
      "MOOD PICKED BY THE OPERATOR: HOT & SENSUAL — intimate, heated. " +
      "[whispering] on the intimate words, heavy [breath] between phrases, [sighing] or [panting] where it burns, " +
      "[break] to build tension, and stretch THE hottest word of each sentence.",
  },
  sleepy: {
    label: "😴 Sleepy",
    instruction:
      "MOOD PICKED BY THE OPERATOR: SLEEPY & COZY — just woke up or falling asleep. " +
      "[soft tone] everywhere, slow lazy rhythm: « ... » between word groups, [sighing] and [breath], " +
      "stretched soft words (« mmmh », « sooo comfy »).",
  },
  sad: {
    label: "😢 Sad",
    instruction:
      "MOOD PICKED BY THE OPERATOR: SAD & FRAGILE — moved, vulnerable. " +
      "[sad] or [moved] on the painful words, [hesitating] before the hard confessions, trembling [breath], " +
      "« ... » to let the emotion sink. [sobbing] only if the text clearly goes there.",
  },
  laughing: {
    label: "😂 Laughing",
    instruction:
      "MOOD PICKED BY THE OPERATOR: LAUGHING — she can barely hold it together. " +
      "[laughing], [chuckling] and [giggling] spread through the text, [breath] to catch air after the laughs, " +
      "playful stretched words.",
  },
  shy: {
    label: "😳 Shy",
    instruction:
      "MOOD PICKED BY THE OPERATOR: SHY & EMBARRASSED — blushing, hesitant. " +
      "[embarrassed], [awkward] or [hesitating] right before the daring words, small nervous [giggling], " +
      "« ... » hesitations mid-sentence, quiet [soft tone].",
  },
  excited: {
    label: "⚡ Excited",
    instruction:
      "MOOD PICKED BY THE OPERATOR: SUPER EXCITED — big news energy. " +
      "[excited] and [delighted] from the start, enthusiastic bursts, [laughing] joy, " +
      "stretched emphasis on the key words (« noooo waaay »), quick [breath] between bursts.",
  },
};

export const DEFAULT_MOOD = "auto";

function buildSystemPrompt(level: number, moodKey: string = DEFAULT_MOOD): string {
  const intensity =
    INTENSITY_LEVELS[level]?.instruction ??
    INTENSITY_LEVELS[DEFAULT_INTENSITY].instruction;
  const mood = MOODS[moodKey]?.instruction ?? null;

  return `You prepare texts for Fish Audio voice synthesis. These are warm, flirty or intimate voice messages sent by a woman to an admirer.

Your task: make the voice feel alive, believable and precisely acted — by inserting emotion tags in brackets AND lightly sculpting how the words sound.

Allowed tags (only these):
- Positive emotions: [excited] [delighted] [joyful] [satisfied] [proud] [confident] [relaxed] [grateful] [moved] [amused] [curious] [interested]
- Negative emotions: [sad] [unhappy] [upset] [depressed] [worried] [anxious] [nervous] [scared] [panicked] [angry] [furious] [frustrated] [impatient] [guilty] [embarrassed] [awkward] [hesitating]
- Other emotions: [surprised] [astonished] [confused] [serious] [sincere] [comforting] [empathetic] [sarcastic]
- Speaking styles: [whispering] [soft tone] [shouting] [screaming] [in a hurry tone]
- Sounds and breathing: [laughing] [chuckling] [giggling] [sobbing] [crying loudly] [sighing] [breath] [panting] [groaning] [cough] [lip-smacking]
- Pauses: [break] [long-break]

${mood ?? "No specific mood was picked: read the text and choose the most believable emotional delivery yourself."}

${intensity}${mood ? "\n(The intensity level caps how sexual the delivery gets; the picked mood drives the emotional color.)" : ""}

WORD-LEVEL PRECISION — this is what makes the voice sound human:
- A tag colors what FOLLOWS it: place it right before the EXACT word to color, not only at sentence start. Example: « I [break] really [whispering] missed you ».
- You may lightly sculpt HOW words sound, without changing the words themselves:
  · stretch the letters of ONE key word per sentence to slow it down (« so » → « soooo », « yes » → « yesss »)
  · add breathy interjections between word groups: « mmh », « ahh », « hmm »
  · add « ... » for hesitation or tension, and commas to force micro-pauses
- NEVER add, remove or replace real words. Only letter-stretching, mmh/ahh/hmm interjections, punctuation and tags.

Strict rules:
- STRICTLY respect the requested intensity level, even if the text seems more or less sexual than the level.
- BREATHING: a voice that breathes is a believable voice. Place [breath] where a real person would catch their breath.
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
  variety = false,
  moodKey: string = DEFAULT_MOOD
): Promise<string> {
  if (EXISTING_TAG.test(text)) return text;

  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!geminiKey && !groqKey && !anthropicKey) return text;

  const systemPrompt = buildSystemPrompt(level, moodKey);

  try {
    const enriched = geminiKey
      ? await enrichWithGemini(text, geminiKey, systemPrompt, variety)
      : groqKey
        ? await enrichWithGroq(text, groqKey, systemPrompt)
        : await enrichWithClaude(text, anthropicKey!, systemPrompt);

    // Garde-fou : si la réponse est vide ou aberrante (trop courte/longue
    // par rapport à l'original), on garde le texte brut. La marge haute
    // couvre les tags + la sculpture (étirements, « mmh », « ... »).
    if (!enriched || enriched.length < text.length * 0.8) return text;
    if (enriched.length > text.length + 400) return text;

    return enriched;
  } catch (err) {
    console.error("Enrichissement LLM échoué, texte brut utilisé:", err);
    return text;
  }
}
