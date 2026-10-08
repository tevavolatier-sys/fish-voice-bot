# Où j'en suis — fish-voice-bot (08/10/2026)

## Fait
- Vocal de bienvenue OnlyFans (Sienna) EN PRODUCTION : webhook OnlyFansAPI wh_3dadc47b… (subscriptions.new + messages.received, géré par l'API via l'action `webhookSetup`), interface https://fish-voice-bot.vercel.app/api/welcome. Prénom par LLM Gemini (vérifié).
- Test A/B vocal / sans vocal EN COURS (coché par Teva) : 18 + 21 fans en attente de leurs 48 h au 07/10. Les réponses ne sont comptées que depuis l'ajout de messages.received (07/10) — les tout premiers fans n'auront pas de réponse enregistrée.
- Audit (workflow 30 agents) appliqué et déployé (536749b) : modèles image Gemini à jour, budget temps Vercel, voix + selfie en parallèle, repli vocal seul, Idempotency-Key, date d'abonnement createdAt, photo réduite côté navigateur, prénoms avec apostrophe.
- Automatisation : Claude pilote l'interface par script (WELCOME_AUTOMATION_KEY sur Vercel, copie locale dans .env.automation, ignoré par git) et déploie (règle dans .claude/settings.local.json, autorisée par Teva le 07/10).
- Selfie « papier avec le prénom » : photo de Sienna installée en prod, zone OK, vocal testé OK. Selfie DÉSACTIVÉ : l'IA Gemini image refuse (« modèles image pas dans l'offre gratuite », 429).

- SELFIE IA ACTIVÉ le 08/10 (OpenAI gpt-image-1-mini, qualité medium, ≈ 0,01 $/selfie ; clé OPENAI_API_KEY sur Vercel). Fonctionnement : seule une vignette autour de la feuille part chez OpenAI (pas de visage → modération OK, 15-25 s), masque = zone d'écriture, puis seule l'encre reliée au prénom est reportée sur la vraie photo (papier/visage/corps intacts, traits parasites effacés), contrôle « prénom coupé » → 2e essai, 2e essai aussi sur refus de modération. Testé en prod : Alex, Dark, Jean, Christopher, Maxou nickel. Pas de secours texte (Teva : fait faux) : si l'IA échoue, vocal seul + raison dans le journal. Gemini en secours seulement si sa facturation est activée (pas le cas).

## En cours
- Premiers vrais envois vocal + selfie : surveiller le journal (colonne « + selfie IA », remarques, erreurs).

## Prochaine étape
1. Claude : après quelques abonnés, relire le journal (`load` via la clé d'automatisation) : part de selfies réussis, délais (budget 55 s), erreurs OpenAI/modération ; ajuster si besoin (qualité low pour 3× moins cher si le rendu reste bon).
2. Test A/B : verdict à partir de 30 fans finis par groupe (interface).
3. Surveiller le journal (premiers envois avec le nouveau code) et le test A/B (verdict à partir de 30 fans finis par groupe).
- Ensuite : vidéos custom au 1er PPV + alerte chatter Telegram.

## À décider par Teva
- Activer la facturation Google (ou renoncer au selfie IA).
- Vidéos PPV en envoi auto ou validation chatter.
