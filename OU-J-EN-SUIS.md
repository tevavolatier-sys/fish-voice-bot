# Où j'en suis — fish-voice-bot (07/10/2026)

## Fait
- Vocal de bienvenue OnlyFans (Sienna) EN PRODUCTION : actif, webhook OnlyFansAPI (wh_3dadc47b…, subscriptions.new, compte acct_55e3…), interface https://fish-voice-bot.vercel.app/api/welcome (mot de passe WELCOME_ADMIN_PASSWORD).
- Vocal = Fish « Enchantée {prénom}… » + vrai enregistrement « moi c'est Sienna, bienvenue » + filtre téléphone. Pseudo illisible → vocal de repli. Prénom par règles (clé Gemini sur Vercel invalide).
- Clé Gemini de chatter-payroll mise sur Vercel (production) ; les LLM sont essayés à tour de rôle ; contrôle : https://fish-voice-bot.vercel.app/api/welcome?check=name (viaLlm doit être true).
- Test A/B codé et commité (b75c2bc + suivant), PAS ENCORE DÉPLOYÉ : 50/50 vocal / sans vocal, réponse du fan comptée dans les 48 h via `messages.received`, carte dans l'interface (interrupteur OFF par défaut, taux par groupe, verdict à partir de 30 fans finis par groupe). Tests : `npx tsx scripts/test-ab.ts`.

## En cours
- Mise en route du test A/B (voir Prochaine étape).

## Prochaine étape
1. Teva : `npx vercel --prod` (déploiement refusé à Claude).
2. Teva : console OnlyFansAPI → webhook wh_3dadc47b → ajouter l'événement `messages.received`.
3. Vérifier ?check=name après déploiement ; si viaLlm=false, nouvelle clé Gemini (aistudio.google.com/apikey).
4. Interface → carte « Test A/B » → cocher. Attendre ~30 fans finis par groupe.
- Ensuite : vidéos custom au 1er PPV + alerte chatter Telegram.

## À décider par Teva
- Vidéos PPV en envoi auto ou validation chatter.
