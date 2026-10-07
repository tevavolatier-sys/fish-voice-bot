// Prénom du fan à partir de son nom / pseudo OnlyFans, pour le vocal de bienvenue.
// « Alex2595839Xxx » → « Alex », « DarkKiller902 » → « Dark », « u48392011 » → "" (illisible).
// Un LLM rapide fait le tri (pseudos tordus) ; les règles servent de garde-fou
// et de repli si aucune clé LLM n'est configurée ou si l'appel échoue.

const TIMEOUT_MS = 8_000;

const SYSTEM = `You extract the word a woman would say out loud to greet a fan, from his OnlyFans display name or username.
Rules:
- Return ONLY that word, nothing else, no punctuation.
- Prefer a real first name if there is one: "Alex2595839Xxx" -> Alex, "john_smith88" -> John, "mr.kevin" -> Kevin.
- Otherwise the first pronounceable word of the pseudo: "DarkKiller902" -> Dark, "BigTom" -> Tom.
- Keep it short: one word, the shortest natural form.
- If nothing is pronounceable (random letters/digits like "u48392011", "xkq77", emojis only): return ?
- The word MUST appear in the input (ignoring case). Never invent a name.`;

/** Mots qui ne se disent pas comme un prénom */
const NOT_NAMES = new Set(["user", "fan", "mr", "mrs", "the", "big", "lil", "little", "xxx", "xx", "official", "real", "only", "sexy", "hot"]);

function capitalize(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/** Un mot prononçable : 2 à 12 lettres, au moins une voyelle, pas de chiffres */
function pronounceable(w: string): boolean {
  return /^[\p{L}']{2,12}$/u.test(w) && /[aeiouyàâäéèêëîïôöùûü]/i.test(w) && !/(.)\1\1/i.test(w);
}

/** Découpe « Alex2595839Xxx » / « dark_killer » / « JohnSmith » en mots */
function words(raw: string): string[] {
  return String(raw ?? "")
    .normalize("NFC")
    .replace(/([\p{Ll}])([\p{Lu}])/gu, "$1 $2")
    .split(/[^\p{L}']+/u)
    .filter(Boolean);
}

/** Règles seules (sans LLM) */
export function nameByRules(raw: string): string {
  for (const w of words(raw)) {
    if (NOT_NAMES.has(w.toLowerCase())) continue;
    if (pronounceable(w)) return capitalize(w);
  }
  return "";
}

/** Réponse du LLM acceptée seulement si c'est un mot prononçable présent dans le pseudo */
export function acceptLlm(answer: string, raw: string): string | null {
  const w = answer.trim().replace(/^["'«\s]+|["'»\s.!]+$/g, "");
  if (w === "?") return "";
  if (!pronounceable(w)) return null;
  const plain = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (!plain(raw).includes(plain(w))) return null;
  return capitalize(w);
}

async function ask(raw: string): Promise<string | null> {
  const user = `Input: ${raw}`;
  const openAiStyle = async (url: string, key: string, model: string) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 10,
        temperature: 0,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return d.choices?.[0]?.message?.content ?? null;
  };

  if (process.env.GEMINI_API_KEY) {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent",
      {
        method: "POST",
        headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 10 },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }
    );
    if (!res.ok) return null;
    const d = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return d.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? null;
  }
  if (process.env.GROQ_API_KEY) {
    return openAiStyle("https://api.groq.com/openai/v1/chat/completions", process.env.GROQ_API_KEY, "llama-3.3-70b-versatile");
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return openAiStyle("https://api.deepseek.com/chat/completions", process.env.DEEPSEEK_API_KEY, "deepseek-chat");
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 10,
        system: SYSTEM,
        messages: [{ role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { content?: { type: string; text?: string }[] };
    return d.content?.find((b) => b.type === "text")?.text ?? null;
  }
  return null;
}

/**
 * Prénom à prononcer, ou "" si le pseudo est illisible.
 * On essaie le nom affiché, puis le @username.
 */
export async function fanFirstName(displayName: string, username = ""): Promise<string> {
  for (const raw of [displayName, username].map((s) => s.trim()).filter(Boolean)) {
    let answer: string | null = null;
    try {
      answer = await ask(raw);
    } catch {
      answer = null;
    }
    const llm = answer === null ? null : acceptLlm(answer, raw);
    const name = llm ?? nameByRules(raw);
    if (name) return name;
  }
  return "";
}
