// Registre des comptes OnlyFansAPI branchés aux automatismes (bienvenue, test A/B, selfie,
// PPV auto, rapport). Même clé OnlyFansAPI pour tous (ONLYFANS_API_KEY).
// Sienna est le compte « historique » : ses données Redis gardent leurs clés d'origine
// (sans suffixe). Les autres comptes ont des clés suffixées (« …:lena », « …:jade »).
// Lena et Jade sont DÉSACTIVÉES par défaut : rien ne part tant que leur interrupteur
// n'est pas activé dans l'interface /api/welcome (sélecteur de modèle en haut).

export type AccountKey = "sienna" | "lena" | "jade";
export type AccountLang = "fr" | "en" | "de";

export interface OfAccount {
  key: AccountKey;
  /** Identifiant du compte chez OnlyFansAPI */
  acct: string;
  /** Pseudo OnlyFans */
  handle: string;
  /** Prénom de la modèle (affiché, alertes) */
  modelName: string;
  /** Clé de la voix Fish (lib/config.ts) */
  voiceKey: string;
  /** Langue parlée et écrite aux fans */
  lang: AccountLang;
  /** true = clés Redis d'origine, sans suffixe (Sienna seulement) */
  legacy: boolean;
}

export const ACCOUNTS: OfAccount[] = [
  { key: "sienna", acct: "acct_55e3b344223d4392bdd02c32d6f27983", handle: "siennaprincesss", modelName: "Sienna", voiceKey: "sienna", lang: "fr", legacy: true },
  { key: "lena", acct: "acct_e5ab4ff15d834a5eb48ba4a817100fc2", handle: "iamlenaaaaaa", modelName: "Lena", voiceKey: "lena", lang: "de", legacy: false },
  { key: "jade", acct: "acct_cef64d382c2c45cda90b8394d0a3a732", handle: "jadeecherryy", modelName: "Jade", voiceKey: "jade", lang: "en", legacy: false },
];

export const SIENNA = ACCOUNTS[0];

/** Compte par clé (« lena ») ; inconnu ou vide → Sienna (comportement d'origine) */
export function accountByKey(k: unknown): OfAccount {
  return ACCOUNTS.find((a) => a.key === k) ?? SIENNA;
}

/** Compte par identifiant acct_… (null si inconnu) */
export function accountByAcct(id: unknown): OfAccount | null {
  return ACCOUNTS.find((a) => a.acct === id) ?? null;
}

/** Paramètre « lena » ou « acct_… » → compte (null si inconnu) */
export function accountFromParam(v: unknown): OfAccount | null {
  if (!v) return null;
  return accountByAcct(v) ?? ACCOUNTS.find((a) => a.key === v) ?? null;
}

/** Clé Redis du compte : d'origine pour Sienna, suffixée pour les autres */
export function scoped(base: string, a: OfAccount): string {
  return a.legacy ? base : `${base}:${a.key}`;
}

/** Préfixe des alertes (vide pour Sienna : textes identiques à avant) */
export function tagOf(a: OfAccount): string {
  return a.legacy ? "" : `[${a.modelName}] `;
}
