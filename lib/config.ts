// ============================================================
// CONFIGURATION — à remplir avant le déploiement
// Remplace chaque placeholder par les vraies valeurs.
// Ce fichier ne contient PAS de secrets (les secrets vont dans
// les variables d'environnement Vercel), il peut être commité.
// ============================================================

export interface VoiceModel {
  /** Identifiant interne court (utilisé dans les boutons et les stats) */
  key: string;
  /** Nom affiché dans le clavier Telegram */
  name: string;
  /** reference_id du clone vocal sur fish.audio */
  referenceId: string;
}

/** Les modèles et leur clone vocal Fish Audio */
export const MODELS: VoiceModel[] = [
  { key: "lea", name: "Lea", referenceId: "REFERENCE_ID_LEA" },
  { key: "jade", name: "Jade", referenceId: "106e5e3c22f5471d96a9401095ae50be" },
  { key: "olivia", name: "Olivia", referenceId: "REFERENCE_ID_OLIVIA" },
  { key: "marie", name: "Marie US", referenceId: "REFERENCE_ID_MARIE_US" },
  { key: "sienna", name: "Sienna", referenceId: "REFERENCE_ID_SIENNA" },
  { key: "skye", name: "Skye", referenceId: "REFERENCE_ID_SKYE" },
];

/**
 * Opérateurs autorisés individuellement (accès en chat privé avec le bot).
 * L'ID Telegram s'obtient en écrivant à @userinfobot.
 * Le nom sert uniquement à l'affichage dans /stats.
 */
export const OPERATORS: { id: number; name: string }[] = [
  // { id: 123456789, name: "Prénom" },
];

/**
 * Groupes Telegram autorisés : tout membre du groupe peut utiliser le bot
 * DANS ce groupe (les stats restent comptées par personne).
 * L'ID d'un groupe est un nombre négatif, ex. -1001234567890.
 */
export const ALLOWED_GROUP_IDS: number[] = [
  -5405936450, // Groupe "FrenchInfluenceVoice BOT"
];

/** ID Telegram de l'admin (seul autorisé à utiliser /stats) */
export const ADMIN_ID = 8202292569; // @chattingtev

/** Limite de caractères par génération */
export const MAX_CHARS = 800;

const allowedUsers = new Set<number>(OPERATORS.map((o) => o.id));
allowedUsers.add(ADMIN_ID);

const allowedGroups = new Set<number>(ALLOWED_GROUP_IDS);

/** Autorisé si l'utilisateur est whitelisté, ou si le message vient d'un groupe autorisé */
export function isAllowed(userId: number, chatId?: number): boolean {
  if (allowedUsers.has(userId)) return true;
  if (chatId !== undefined && allowedGroups.has(chatId)) return true;
  return false;
}

export function modelByKey(key: string): VoiceModel | undefined {
  return MODELS.find((m) => m.key === key);
}

export function operatorName(userId: number | string): string {
  const id = Number(userId);
  if (id === ADMIN_ID) return "Admin";
  return OPERATORS.find((o) => o.id === id)?.name ?? String(userId);
}
