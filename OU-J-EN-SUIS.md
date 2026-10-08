# Où j'en suis — fish-voice-bot (07/10/2026)

## Fait
- Vocal de bienvenue OnlyFans (Sienna) EN PRODUCTION : webhook OnlyFansAPI wh_3dadc47b… (subscriptions.new + messages.received, géré par l'API via l'action `webhookSetup`), interface https://fish-voice-bot.vercel.app/api/welcome. Prénom par LLM Gemini (vérifié).
- Test A/B vocal / sans vocal EN COURS (coché par Teva) : 18 + 21 fans en attente de leurs 48 h au 07/10. Les réponses ne sont comptées que depuis l'ajout de messages.received (07/10) — les tout premiers fans n'auront pas de réponse enregistrée.
- Audit (workflow 30 agents) appliqué et déployé (536749b) : modèles image Gemini à jour, budget temps Vercel, voix + selfie en parallèle, repli vocal seul, Idempotency-Key, date d'abonnement createdAt, photo réduite côté navigateur, prénoms avec apostrophe.
- Automatisation : Claude pilote l'interface par script (WELCOME_AUTOMATION_KEY sur Vercel, copie locale dans .env.automation, ignoré par git) et déploie (règle dans .claude/settings.local.json, autorisée par Teva le 07/10).
- Selfie « papier avec le prénom » : photo de Sienna installée en prod, zone OK, vocal testé OK. Selfie DÉSACTIVÉ : l'IA Gemini image refuse (« modèles image pas dans l'offre gratuite », 429).

- Teva a choisi OpenAI GPT Image Mini (≈ 0,01 $/selfie, ≈ 10 $/mois pour ~1 100 selfies) plutôt que Gemini (≈ 37 $/mois). Code OpenAI fait : masque exact de la zone, composition « zone seule » sur la vraie photo (testé en local avec une fausse image IA : OK), Gemini en secours. Déployé, selfie toujours DÉSACTIVÉ.

## En cours
- Attente de la clé OpenAI de Teva (platform.openai.com → Billing carte + 5 $ → API keys).

## Prochaine étape
1. Dès réception de la clé : `npx vercel env add OPENAI_API_KEY production` → `npx vercel --prod` → `selfieTest` IA sur « Alex2595839Xxx » → montrer le résultat → `selfieSave enabled` si OK.
2. Si la modération OpenAI refuse la photo (décolleté) : essayer une autre photo plus sage, ou Gemini (carte Google).
3. Surveiller le journal (premiers envois avec le nouveau code) et le test A/B (verdict à partir de 30 fans finis par groupe).
- Ensuite : vidéos custom au 1er PPV + alerte chatter Telegram.

## À décider par Teva
- Activer la facturation Google (ou renoncer au selfie IA).
- Vidéos PPV en envoi auto ou validation chatter.
