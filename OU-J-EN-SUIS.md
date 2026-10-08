# Où j'en suis — fish-voice-bot (07/10/2026)

## Fait
- Vocal de bienvenue OnlyFans (Sienna) EN PRODUCTION : webhook OnlyFansAPI (wh_3dadc47b…, compte acct_55e3…), interface https://fish-voice-bot.vercel.app/api/welcome (mot de passe WELCOME_ADMIN_PASSWORD). Prénom par LLM Gemini (vérifié : ?check=name → viaLlm true).
- Test A/B vocal / sans vocal (50/50, réponse dans les 48 h) DÉPLOYÉ : tableau détaillé (pourcentages, <1 h / <24 h, délai médian, confiance, reply rate global). Teva devait cocher « Test A/B » + ajouter `messages.received` au webhook.
- Selfie « papier avec le prénom » codé et commité, PAS DÉPLOYÉ : lib/selfie.ts, IA Gemini seule (vrai inpainting, modèles essayés en cascade gemini-3.1-flash-image → 2.5), zone d'écriture = 4 coins montrés à l'IA en liseré rouge (aperçu « Voir la zone »), pas de selfie si l'IA échoue (texte posé = option, Teva le trouve faux). Même message que le vocal. IA testable seulement sur Vercel (Gemini bloqué en Polynésie).

## En cours
- Mise en service du selfie.

## Prochaine étape
1. Teva : `cd "C:\Users\Teva\Documents\Claude code\fish-voice-bot"; npx.cmd vercel --prod`
2. Interface → carte Selfie → installer la photo (celle du 07/10, papier blanc) → Essayer « Alex2595839Xxx » en mode IA → si l'IA échoue (modèle inconnu) : changer WELCOME_IMAGE_MODEL sur Vercel (gemini-3.1-flash-image, gemini-nano-banana-2.1…) ou rester en « Texte posé ».
3. Cocher « Selfie : ACTIF ».
- Ensuite : vidéos custom au 1er PPV + alerte chatter Telegram.

## À décider par Teva
- Pseudo illisible → pas de selfie (choix actuel) ou photo sans prénom ?
- Vidéos PPV en envoi auto ou validation chatter.
