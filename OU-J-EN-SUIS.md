# Où j'en suis — fish-voice-bot (08/10/2026)

## Fait
- Vocal de bienvenue OnlyFans (Sienna) EN PRODUCTION : webhook OnlyFansAPI wh_3dadc47b… (subscriptions.new + messages.received, géré par l'API via l'action `webhookSetup`), interface https://fish-voice-bot.vercel.app/api/welcome. Prénom par LLM Gemini (vérifié).
- Test A/B vocal / sans vocal EN COURS (coché par Teva) : 18 + 21 fans en attente de leurs 48 h au 07/10. Les réponses ne sont comptées que depuis l'ajout de messages.received (07/10) — les tout premiers fans n'auront pas de réponse enregistrée.
- Audit (workflow 30 agents) appliqué et déployé (536749b) : modèles image Gemini à jour, budget temps Vercel, voix + selfie en parallèle, repli vocal seul, Idempotency-Key, date d'abonnement createdAt, photo réduite côté navigateur, prénoms avec apostrophe.
- Automatisation : Claude pilote l'interface par script (WELCOME_AUTOMATION_KEY sur Vercel, copie locale dans .env.automation, ignoré par git) et déploie (règle dans .claude/settings.local.json, autorisée par Teva le 07/10).
- Selfie « papier avec le prénom » : photo de Sienna installée en prod, zone OK, vocal testé OK. Selfie DÉSACTIVÉ : l'IA Gemini image refuse (« modèles image pas dans l'offre gratuite », 429).

- SELFIE IA ACTIVÉ le 08/10 (OpenAI gpt-image-1-mini, qualité medium, ≈ 0,01 $/selfie ; clé OPENAI_API_KEY sur Vercel). Fonctionnement : seule une vignette autour de la feuille part chez OpenAI (pas de visage → modération OK, 15-25 s), masque = zone d'écriture, puis seule l'encre reliée au prénom est reportée sur la vraie photo (papier/visage/corps intacts, traits parasites effacés), contrôle « prénom coupé » → 2e essai, 2e essai aussi sur refus de modération. Testé en prod : Alex, Dark, Jean, Christopher, Maxou nickel. Pas de secours texte (Teva : fait faux) : si l'IA échoue, vocal seul + raison dans le journal. Gemini en secours seulement si sa facturation est activée (pas le cas).

- 08/10 réalisme (Teva : « pas assez réaliste, il faut voir que c'est fait à la main ») : 3 panels de juges (workflows) → style cursif par défaut (DEFAULT_STYLE, surcharge WELCOME_STYLE), rendu « vrai feutre » déterministe dans compositeZone (encre qui assombrit le papier, pression variable par bruit, bords baveux, plus chargée aux croisements ; WELCOME_INK 0,84 / WELCOME_INK_BLUR 0,6 / WELCOME_INK_PRESSURE 0,45). Échantillon de la vraie écriture de Sienna possible (interface → « Vraie écriture de la modèle », 2e image passée à OpenAI) : demandé à Teva, pas reçu. Essais par script : selfieTest accepte model/quality/style/noReference.

- Panel 3 : gpt-image-1 cursif 6,5/10, mini cursif 5,7/10 (écart faible pour 4× le prix) → on reste sur mini ; reproche restant « encre grise » corrigé (cœur du trait saturé, WELCOME_INK 0,88, pression 0,3).

- 08/10 (Teva : « encore trop fake ») → méthode « note » (défaut, WELCOME_AI_METHOD=edit pour l'ancienne) : OpenAI GÉNÈRE une photo de note manuscrite (images/generations, 12-15 s), lib/selfie.ts placeNote découpe l'encre (pickNoteInk : taches sur la ligne du prénom, exit souligné/pointillés), la pose en perspective dans la zone (70 % de largeur, anti-crénelage) et renderInk fait le rendu feutre. Panel 4 : note 5,8 / edit 4,1 (unanime) → note par défaut ; trous blancs aux croisements corrigés (plancher papier médian + fermeture morphologique, closeHoles).

## En cours
- Prod : mini + méthode note + encre vrai feutre v2. Pour passer sur gpt-image-1 (≈ 0,04 $/selfie, un peu plus crédible) : `vercel env add WELCOME_OPENAI_MODEL production` = gpt-image-1.
- Premiers vrais envois vocal + selfie : surveiller le journal (colonne « + selfie IA », remarques, erreurs).

## Prochaine étape
0. Si Teva envoie une photo de l'écriture de Sienna : l'installer (action selfieHandwriting / interface) — NB : elle ne sert qu'à la méthode « edit » (2e image de référence) ; pour la méthode « note », l'ajouter aussi comme référence dans selfieByNote (images/edits avec l'échantillon comme image d'entrée, ou passer en « edit » avec référence) → à coder le moment venu.
1. Claude : après quelques abonnés, relire le journal (`load` via la clé d'automatisation) : part de selfies réussis, délais (budget 55 s), erreurs OpenAI/modération ; ajuster si besoin (qualité low pour 3× moins cher si le rendu reste bon).
2. Test A/B : verdict à partir de 30 fans finis par groupe (interface).
3. Surveiller le journal (premiers envois avec le nouveau code) et le test A/B (verdict à partir de 30 fans finis par groupe).
- Ensuite : vidéos custom au 1er PPV + alerte chatter Telegram.

## À décider par Teva
- Activer la facturation Google (ou renoncer au selfie IA).
- Vidéos PPV en envoi auto ou validation chatter.
