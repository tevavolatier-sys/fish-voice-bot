// Client Fish Audio TTS — https://api.fish.audio/v1/tts

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const ATTEMPT_TIMEOUT_MS = 25_000;

// Modèle TTS Fish Audio. Défaut : s1 (premium, payant aux crédits — rendu
// NSFW bien meilleur que le gratuit, choix Teva 2026-07-23). Pour revenir au
// gratuit sans toucher au code : FISH_MODEL=s2.1-pro-free dans Vercel.
function fishModel(): string {
  return process.env.FISH_MODEL?.trim() || "s1";
}

/** Erreur avec un message clair destiné à l'opérateur (en français) */
export class FishError extends Error {
  constructor(public readonly userMessage: string, detail: string) {
    super(detail);
    this.name = "FishError";
  }
}

function mapClientError(status: number, body: string): FishError {
  switch (status) {
    case 401:
    case 403:
      return new FishError(
        "🔑 Invalid or revoked Fish Audio API key. Check FISH_API_KEY in the Vercel settings.",
        `Fish ${status}: ${body}`
      );
    case 402:
      return new FishError(
        "💳 Fish Audio credits exhausted. Top up the account on fish.audio and try again.",
        `Fish 402: ${body}`
      );
    case 404:
      return new FishError(
        "🎤 Voice not found: this model's reference_id is invalid. Check lib/config.ts.",
        `Fish 404: ${body}`
      );
    case 429:
      return new FishError(
        "⏳ Fish Audio quota or rate limit reached. Wait a bit and try again.",
        `Fish 429: ${body}`
      );
    case 400:
    case 422:
      return new FishError(
        "❌ Request rejected by Fish Audio (invalid reference_id or unsupported text).",
        `Fish ${status}: ${body}`
      );
    default:
      return new FishError(
        `❌ Fish Audio error (code ${status}). Try again; if it keeps happening, tell the admin.`,
        `Fish ${status}: ${body}`
      );
  }
}

/**
 * Solde de crédits API Fish Audio (en dollars), null si indisponible.
 * Sert à /credits et à l'alerte automatique de crédits bas (le modèle s1
 * est payant : chaque vocal consomme des crédits).
 */
export async function getFishCredits(): Promise<number | null> {
  try {
    const res = await fetch("https://api.fish.audio/wallet/self/api-credit", {
      headers: { Authorization: `Bearer ${process.env.FISH_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { credit?: string | number };
    const n = Number(data.credit);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Génère un MP3 via Fish Audio.
 * Retente automatiquement 1 fois en cas d'erreur 5xx ou de timeout.
 * Lance une FishError avec un message clair pour l'opérateur en cas d'échec.
 */
export async function generateVoice(
  text: string,
  referenceId: string
): Promise<Buffer> {
  let lastError: FishError | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(FISH_TTS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.FISH_API_KEY}`,
          "Content-Type": "application/json",
          model: fishModel(),
        },
        body: JSON.stringify({
          text,
          reference_id: referenceId,
          format: "mp3",
          mp3_bitrate: 128,
        }),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
    } catch (err) {
      // Timeout ou erreur réseau -> on retente une fois
      lastError = new FishError(
        "⚠️ Fish Audio is not responding (timeout). Try again in a moment.",
        `Tentative ${attempt}: ${String(err)}`
      );
      continue;
    }

    if (res.ok) {
      return Buffer.from(await res.arrayBuffer());
    }

    const body = await res.text().catch(() => "");
    if (res.status >= 500) {
      // Erreur serveur -> on retente une fois
      lastError = new FishError(
        "⚠️ Fish Audio is temporarily unavailable (server error). Try again in a moment.",
        `Tentative ${attempt}, Fish ${res.status}: ${body}`
      );
      continue;
    }

    // Erreur client : inutile de retenter
    throw mapClientError(res.status, body);
  }

  throw lastError!;
}
