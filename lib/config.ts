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
  /**
   * Langue dans laquelle la modèle PARLE. Les opérateurs (Philippines)
   * écrivent en anglais : pour une voix "fr", le bot TRADUIT le texte en
   * français avant la synthèse. Pour une voix "en", le texte part tel quel.
   */
  lang: "fr" | "en" | "de";
}

/** Les modèles et leur clone vocal Fish Audio */
// Voix de la bibliothèque publique Fish Audio (pas de clone des créatrices) ;
// toutes adultes. Mise à jour 2026-10-11 : une voix par créatrice Infloww.
export const MODELS: VoiceModel[] = [
  // 🇺🇸 Anglais
  // Lea : l'ancienne voix (a71f0b05…, « Friendly Teen Voice ») a été remplacée
  // le 2026-10-11 : une voix d'ado n'a rien à faire sur du contenu adulte.
  { key: "lea", name: "Lea", referenceId: "933563129e564b19a115bedd57b7406a", lang: "en" }, // Sarah
  { key: "jade", name: "Jade", referenceId: "106e5e3c22f5471d96a9401095ae50be", lang: "en" }, // Megan
  { key: "marieus", name: "Marie US", referenceId: "b347db033a6549378b48d00acb0d06cd", lang: "en" }, // Selene
  // 🇫🇷 Français
  // Olivia retirée de l'agence (2026-07-25). Son clone vocal existait sous
  // le reference_id 6dd1a537aae14896967955481b85d472 si besoin un jour.
  { key: "sienna", name: "Sienna", referenceId: "aa13d26cfc6e41f1b1f7a02bf5baa606", lang: "fr" }, // Lucille
  { key: "lisa", name: "Lisa", referenceId: "8569d3f9471941f380ff3710fcc28d29", lang: "fr" }, // Voix Douce et Chaleureuse
  { key: "laura", name: "Laura", referenceId: "da05ae30d8c0428eb47498df524e448c", lang: "fr" }, // Claire
  { key: "marie", name: "Marie", referenceId: "5efc335186f544808d99ad2ff7b0336d", lang: "fr" }, // Voix Féminine Chaleureuse
  { key: "alina", name: "Alina", referenceId: "6dafffa3a0e24661b741fa8743e8246d", lang: "fr" }, // Mariette française
  { key: "livia", name: "Livia", referenceId: "342e8521b31248378fe7f68481a4886e", lang: "fr" }, // Amanda
  // 🇩🇪 Allemand
  { key: "lena", name: "Lena", referenceId: "194b99d7c27e462ea40694cddf1f7c96", lang: "de" }, // EMILIA GERMAN
  { key: "skye", name: "Skye", referenceId: "REFERENCE_ID_SKYE", lang: "en" },
];

/** Drapeau affiché à côté du nom : la langue que la voix va parler */
export const LANG_FLAG: Record<VoiceModel["lang"], string> = { fr: "🇫🇷", en: "🇺🇸", de: "🇩🇪" };

/** Nom + drapeau, pour les boutons et les légendes */
export function modelLabel(m: VoiceModel): string {
  return `${m.name} ${LANG_FLAG[m.lang]}`;
}

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
  // "VOICE BOT - French Influence Agency" (supergroupe — l'ancien groupe
  // -5405936450 a été converti par Telegram, son ID a changé)
  -1004454486728,
];

/** ID Telegram de l'admin (seul autorisé à utiliser /stats) */
export const ADMIN_ID = 8202292569; // @chattingtev

/** Limite de caractères par génération */
export const MAX_CHARS = 800;

/**
 * Voix réellement utilisables : celles dont le reference_id a été rempli.
 * Les modèles encore en placeholder n'apparaissent pas dans le clavier.
 */
export const ACTIVE_MODELS: VoiceModel[] = MODELS.filter(
  (m) => !m.referenceId.startsWith("REFERENCE_ID_")
);

/**
 * Lecteurs (ex. le CEO) : utilisent le bot, voient /stats et /credits et
 * reçoivent les rapports, sans pouvoir rien régler. IDs Telegram dans la
 * variable Vercel VIEWER_IDS, séparés par des virgules.
 */
export const VIEWER_IDS: number[] = (process.env.VIEWER_IDS ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isSafeInteger(n) && n > 0);

/** Admin ou lecteur : peut regarder les stats et reçoit les rapports */
export function canView(userId: number | undefined): boolean {
  return userId === ADMIN_ID || (userId !== undefined && VIEWER_IDS.includes(userId));
}

const allowedUsers = new Set<number>(OPERATORS.map((o) => o.id));
allowedUsers.add(ADMIN_ID);
for (const id of VIEWER_IDS) allowedUsers.add(id);

const allowedGroups = new Set<number>(ALLOWED_GROUP_IDS);

/** Autorisé si l'utilisateur est whitelisté, ou si le message vient d'un groupe autorisé */
export function isAllowed(userId: number, chatId?: number): boolean {
  if (allowedUsers.has(userId)) return true;
  if (chatId !== undefined && allowedGroups.has(chatId)) return true;
  return false;
}

export function modelByKey(key: string): VoiceModel | undefined {
  return ACTIVE_MODELS.find((m) => m.key === key);
}

export function operatorName(userId: number | string): string {
  const id = Number(userId);
  if (id === ADMIN_ID) return "Admin";
  if (VIEWER_IDS.includes(id)) return "CEO";
  return OPERATORS.find((o) => o.id === id)?.name ?? String(userId);
}
