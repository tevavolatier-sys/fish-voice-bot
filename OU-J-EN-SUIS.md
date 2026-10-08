# Où j'en suis — fish-voice-bot (07/10/2026)

## Fait
- Vocal de bienvenue OnlyFans (Sienna) EN PRODUCTION : webhook OnlyFansAPI wh_3dadc47b… (subscriptions.new + messages.received, géré par l'API via l'action `webhookSetup`), interface https://fish-voice-bot.vercel.app/api/welcome. Prénom par LLM Gemini (vérifié).
- Test A/B vocal / sans vocal EN COURS (coché par Teva) : 18 + 21 fans en attente de leurs 48 h au 07/10. Les réponses ne sont comptées que depuis l'ajout de messages.received (07/10) — les tout premiers fans n'auront pas de réponse enregistrée.
- Audit (workflow 30 agents) appliqué et déployé (536749b) : modèles image Gemini à jour, budget temps Vercel, voix + selfie en parallèle, repli vocal seul, Idempotency-Key, date d'abonnement createdAt, photo réduite côté navigateur, prénoms avec apostrophe.
- Automatisation : Claude pilote l'interface par script (WELCOME_AUTOMATION_KEY sur Vercel, copie locale dans .env.automation, ignoré par git) et déploie (règle dans .claude/settings.local.json, autorisée par Teva le 07/10).
- Selfie « papier avec le prénom » : photo de Sienna installée en prod, zone OK, vocal testé OK. Selfie DÉSACTIVÉ : l'IA Gemini image refuse (« modèles image pas dans l'offre gratuite », 429).

## En cours
- Selfie IA bloqué par la facturation Google (voir Prochaine étape).

## Prochaine étape
1. Teva (seul point manuel) : https://aistudio.google.com/apikey → projet Google Cloud de la clé GEMINI_API_KEY → Facturation → associer une carte (Tier 1). ≈ 0,04 $ par selfie (nano-banana-2.1). Si la clé date d'avant : en créer une nouvelle et me la donner.
2. Dès que c'est fait, Claude : `selfieTest` en IA → montrer le résultat à Teva → activer le selfie (`selfieSave enabled`).
3. Surveiller le journal (premiers envois avec le nouveau code) et le test A/B (verdict à partir de 30 fans finis par groupe).
- Ensuite : vidéos custom au 1er PPV + alerte chatter Telegram.

## À décider par Teva
- Activer la facturation Google (ou renoncer au selfie IA).
- Vidéos PPV en envoi auto ou validation chatter.
