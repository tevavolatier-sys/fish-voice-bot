# Plan — PPV perso automatique à l'achat du PPV de bienvenue (11/10/2026)

## Déclencheur
- Webhook OnlyFansAPI `messages.ppv.unlocked` (compte Sienna).
- On relit le message acheté (`payload.message_id`) : s'il commence par « OUVRE CA et attends 5 min… » → c'est le PPV de bienvenue → on déclenche. Une seule fois par fan.
- Prénom : `payload.fan.display_name` (le nom modifié par le chatter sur OF) en priorité, sinon le même détecteur que le vocal de bienvenue (pseudo → prénom). Pas de prénom lisible → alerte au chatter sans vidéo.

## Génération (identique à `/ppv Prénom` du bot Telegram, rien n'est changé)
- Même code : preview + PPV1 avec le prénom, réglages /ppvsettings de Sienna, PPV2 inchangé (déjà dans le vault).
- Sorties : `preview-prenom.mp4` et `ppv1-prenom.mp4`.

## Vault OnlyFans
- Upload des 2 vidéos dans le vault (API), création d'un dossier (liste) « PPV1 - Prénom » avec les 2 vidéos.
- 30 min après : le dossier est supprimé (tâche planifiée toutes les 5 min). Les fichiers eux-mêmes restent dans « Tous les médias » et sont supprimés 24 h après (à confirmer).

## Alerte Telegram (bot dédié, texte seul, en anglais)
« 💰 Alex (@alex_92) just bought the welcome PPV ($15). His preview + PPV1 videos are ready in the vault, folder “PPV1 - Alex” (deleted in 30 min). Chat: onlyfans.com/my/chats/chat/123 »

## Interface (onglet dans /api/welcome)
- ON/OFF, texte-déclencheur modifiable, journal (fan, prénom, montant, vidéos OK/KO, dossier créé/supprimé), bouton « Regénérer ».

## À fournir par Teva
1. Token BotFather du bot d'alerte + ID du groupe/chat Telegram des chatters.
2. OK pour supprimer les fichiers du vault 24 h après (ou les garder).
