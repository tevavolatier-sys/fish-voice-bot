// Client Fish Audio TTS — https://api.fish.audio/v1/tts

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const ATTEMPT_TIMEOUT_MS = 25_000;

// Modèle TTS Fish Audio. Défaut : s2.1-pro (premium, payant aux crédits).
// ⚠️ NE PAS mettre "s1" : il attend des tags (parenthèses) en début de
// phrase — nos tags [crochets] ne sont pas reconnus et sont PRONONCÉS
// (mots inventés, bug du 2026-07-23). La famille s2.x lit les [crochets].
// Repli gratuit sans toucher au code : FISH_MODEL=s2.1-pro-free dans Vercel.
function fishModel(): string {
  return process.env.FISH_MODEL?.trim() || "s2.1-pro";
}

// Effet léger « téléphone / un peu éloignée » sur TOUS les vocaux générés (Teva, 15/10 : voix trop fades).
// Bande coupée en bas et en haut + médiums relevés + petite réflexion de pièce. VOICE_FX=none dans Vercel pour couper,
// ou une autre chaîne de filtres ffmpeg pour la remplacer. En cas d'échec, le vocal part sans effet.
const DEFAULT_FX =
  "highpass=f=220,lowpass=f=5200,equalizer=f=1700:t=q:w=1.2:g=3.5,aecho=0.85:0.5:28|47:0.14|0.08,volume=1.15";

async function voiceFx(mp3: Buffer): Promise<Buffer> {
  const fx = process.env.VOICE_FX?.trim() || DEFAULT_FX;
  if (fx === "none") return mp3;
  const { ffmpegBinary, run } = await import("./video.js");
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "fx-"));
  try {
    const inp = join(dir, "in.mp3");
    const out = join(dir, "out.mp3");
    await writeFile(inp, mp3);
    const r = await run(await ffmpegBinary(), ["-y", "-hide_banner", "-i", inp, "-af", fx, "-c:a", "libmp3lame", "-b:a", "128k", out]);
    if (r.code !== 0) throw new Error(r.stderr.slice(-200));
    return await readFile(out);
  } catch (e) {
    console.error("[voiceFx] effet ignoré :", e);
    return mp3;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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
/** Réglages facultatifs de la synthèse (prises « fixes » plus stables). */
export interface VoiceOptions {
  model?: string; // modèle Fish (en-tête « model ») ; sinon FISH_MODEL / s2.1-pro
  temperature?: number;
  top_p?: number;
  speed?: number;
}

export async function generateVoice(
  text: string,
  referenceId: string,
  opts: VoiceOptions = {}
): Promise<Buffer> {
  let lastError: FishError | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(FISH_TTS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.FISH_API_KEY}`,
          "Content-Type": "application/json",
          model: opts.model ?? fishModel(),
        },
        body: JSON.stringify({
          text,
          reference_id: referenceId,
          format: "mp3",
          mp3_bitrate: 128,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts.top_p !== undefined ? { top_p: opts.top_p } : {}),
          ...(opts.speed !== undefined ? { prosody: { speed: opts.speed } } : {}),
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
      return await voiceFx(Buffer.from(await res.arrayBuffer()));
    }

    const body = await res.text().catch(() => "");
    if (res.status === 429 && attempt < 3) {
      // Trop de requêtes en même temps (limite de Fish) : on attend un peu
      lastError = mapClientError(res.status, body);
      await new Promise((r) => setTimeout(r, 1200 * attempt + Math.random() * 800));
      continue;
    }
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
