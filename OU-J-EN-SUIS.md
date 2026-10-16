# Où j'en suis — Voice Bot (2026-10-15)

**Fait** : (15/10) effet léger téléphone / éloignement sur tous les vocaux générés (VOICE_FX=none pour couper) ; échantillon test-Alex-effet.mp3.  bienvenue, test A/B, selfie, PPV auto et rapport marchent pour 3 comptes (Sienna, Lena 🇩🇪, Jade 🇺🇸) ; sélecteur de modèle en haut de /api/welcome ; Sienna inchangée ; Lena et Jade sur OFF. Compteur de crédits OnlyFansAPI commun (aussi mass-dm-of) + plafond par jour (4000, réglable dans l'interface). Déployé, testé à blanc (vocaux DE/EN générés, rien envoyé).
**En cours** : —
**Prochaine étape** : (15/10) test A/B v90 actif d'office pour Lena et Jade (9/10 vocal perso dans leur voix, 1/10 rien), reste à les mettre sur ON.  Teva écoute les vocaux de Lena et Jade dans l'interface (choisir la modèle en haut → Tester / ▶ Écouter), puis les met sur ON.
**À décider par Teva** : textes de relance « Netflix » de Lena/Jade (écrits sans connaître le vrai vocal de Sienna) ; début du PPV de bienvenue de Lena/Jade (texte des chatters) et leurs vidéos PPV 1 à charger dans le bot ; retirer ENRICH_TEST_SECRET de Vercel ; langue de Livia et d'Alina.
