# Où j'en suis — fish-voice-bot (06/10/2026)

## Fait
- Vocal de bienvenue OnlyFans (Sienna seule) : « Prénom… » + partie fixe ; pseudo illisible → vocal de repli. Prénom trouvé par LLM (lib/fan-name.ts, garde-fou par règles).
- Interface `/api/welcome` : générer 5 prises de la partie fixe / du repli, choisir, tester un pseudo, journal, jauge 20 000 req/mois (blocage à 90 %).
- Webhook `api/of-webhook.ts` (subscriptions.new). Typecheck OK, parcours testé en aperçu local (`npx tsx scripts/dev-welcome.ts`, mdp demo). Non déployé, non commité.

## Prochaine étape
- Vercel : ONLYFANS_API_KEY, ONLYFANS_WEBHOOK_SECRET, WELCOME_ADMIN_PASSWORD (+ une clé LLM GEMINI/GROQ déjà présente ?), puis déployer.
- Interface en ligne : générer et choisir les prises, tester des pseudos, renseigner acct_ de Sienna, activer.
- Console OnlyFansAPI : webhook https://<projet>.vercel.app/api/of-webhook, événement subscriptions.new.
- Ensuite : vidéos custom au 1er PPV + alerte chatter Telegram.

## À décider par Teva
- OK pour déployer ; vidéos PPV en envoi auto ou validation chatter.
