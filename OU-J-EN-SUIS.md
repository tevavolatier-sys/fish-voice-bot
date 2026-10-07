# Où j'en suis — fish-voice-bot (07/10/2026)

## Fait
- Vocal de bienvenue OnlyFans (Sienna) déployé : https://fish-voice-bot.vercel.app/api/welcome (sans mot de passe).
- Vercel : ONLYFANS_API_KEY, ONLYFANS_WEBHOOK_SECRET, ajoutés ; prénom extrait par Gemini (clé déjà présente). Compte acct_55e3… (Sienna) enregistré.

## En cours
- Rien.

## Prochaine étape
- Console OnlyFansAPI : webhook https://fish-voice-bot.vercel.app/api/of-webhook, événement subscriptions.new, secret = ONLYFANS_WEBHOOK_SECRET de .env.local.
- Interface : générer/choisir les prises (fixe + repli), tester des pseudos, cocher Actif, vérifier avec un vrai nouvel abonné.
- Ensuite : vidéos custom au 1er PPV + alerte chatter Telegram.

## À décider par Teva
- Vidéos PPV en envoi auto ou validation chatter.
