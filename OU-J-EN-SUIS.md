# Où j'en suis — fish-voice-bot (07/10/2026)

## Fait
- Vocal de bienvenue OnlyFans (Sienna) EN PRODUCTION : actif, webhook OnlyFansAPI créé (wh_3dadc47b…, subscriptions.new, compte acct_55e3…), interface https://fish-voice-bot.vercel.app/api/welcome (sans mot de passe).
- Vocal = Fish « Enchantée {prénom}… » (une phrase) + vrai enregistrement « moi c'est Sienna, bienvenue » + filtre téléphone (MP3 48k). Pseudo illisible → vocal de repli Fish. Prénom par règles (clé Gemini sur Vercel invalide → repli règles, ça marche).
- Vitesse x1, éloignement coupé (WELCOME_DISTANCE=0), pièce sur le prénom coupée (WELCOME_NAME_ROOM=dry).

## En cours
- Attendre le 1er vrai abonné et vérifier le journal dans l'interface.

## Prochaine étape
- Si l'envoi réel échoue : regarder le journal (bouton Renvoyer) et les logs Vercel.
- Remplacer la clé GEMINI_API_KEY sur Vercel (invalide) si on veut le LLM pour les pseudos tordus.
- Ensuite : vidéos custom au 1er PPV + alerte chatter Telegram.

## À décider par Teva
- Vidéos PPV en envoi auto ou validation chatter.
