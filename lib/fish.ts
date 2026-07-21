// Client Fish Audio TTS — https://api.fish.audio/v1/tts

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const ATTEMPT_TIMEOUT_MS = 25_000;

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
        "🔑 Clé API Fish Audio invalide ou révoquée. Vérifie FISH_API_KEY dans les réglages Vercel.",
        `Fish ${status}: ${body}`
      );
    case 402:
      return new FishError(
        "💳 Crédits Fish Audio épuisés. Recharge le compte sur fish.audio puis réessaie.",
        `Fish 402: ${body}`
      );
    case 404:
      return new FishError(
        "🎤 Voix introuvable : le reference_id de cette modèle est invalide. Vérifie lib/config.ts.",
        `Fish 404: ${body}`
      );
    case 429:
      return new FishError(
        "⏳ Quota ou limite de débit Fish Audio atteint. Attends un peu puis réessaie.",
        `Fish 429: ${body}`
      );
    case 400:
    case 422:
      return new FishError(
        "❌ Requête refusée par Fish Audio (reference_id invalide ou texte non accepté).",
        `Fish ${status}: ${body}`
      );
    default:
      return new FishError(
        `❌ Erreur Fish Audio (code ${status}). Réessaie ; si ça persiste, préviens l'admin.`,
        `Fish ${status}: ${body}`
      );
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
          model: "s2.1-pro-free",
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
        "⚠️ Fish Audio ne répond pas (timeout). Réessaie dans quelques instants.",
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
        "⚠️ Fish Audio est momentanément indisponible (erreur serveur). Réessaie dans quelques instants.",
        `Tentative ${attempt}, Fish ${res.status}: ${body}`
      );
      continue;
    }

    // Erreur client : inutile de retenter
    throw mapClientError(res.status, body);
  }

  throw lastError!;
}
