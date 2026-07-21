# 🎙️ Fish Voice Bot

Bot Telegram interne pour l'équipe : chaque opérateur choisit une modèle, envoie un texte (avec tags d'émotion Fish Audio) et reçoit une **voice note** générée avec le clone vocal de la modèle.

- Hébergement **gratuit** sur Vercel (serverless, aucun serveur à maintenir)
- Voix générées par l'API **Fish Audio** (clones déjà créés sur fish.audio)
- Sélection de la modèle et statistiques stockées dans **Upstash Redis** (gratuit)
- Accès restreint à une **whitelist** de 5 opérateurs + 1 admin

## Commandes du bot

| Commande | Qui | Effet |
|---|---|---|
| `/start` ou `/voix` | Opérateurs | Choisir la modèle (boutons) |
| *(texte libre)* | Opérateurs | Génère la voice note avec la modèle active (max 800 caractères) |
| `/aide` | Opérateurs | Liste des tags d'émotion `[whisper]`, `[excited]`… |
| `/stats` | Admin uniquement | Générations + caractères par modèle et par opérateur |
| `/stats reset` | Admin uniquement | Remet les compteurs à zéro |

---

# Installation pas à pas (aucune connaissance technique requise)

## Étape 1 — Créer le bot Telegram avec BotFather

1. Dans Telegram, cherche **@BotFather** (le vrai, avec le badge bleu) et ouvre la conversation.
2. Envoie `/newbot`.
3. Donne un nom (ex. `Voice Team`) puis un identifiant finissant par `bot` (ex. `voiceteam_bot`).
4. BotFather te répond avec le **token du bot**, du genre `123456789:AAxxxxxxx...`.
   👉 **Copie-le dans un coin, c'est ta variable `BOT_TOKEN`. Ne le partage jamais.**

## Étape 2 — Récupérer les IDs Telegram de l'équipe

1. Chaque opérateur (et toi, l'admin) écrit à **@userinfobot** dans Telegram.
2. Le bot répond avec `Id: 123456789` → c'est l'ID Telegram de la personne.
3. Note les 5 IDs des opérateurs + ton ID (admin).

## Étape 3 — Récupérer la clé API et les reference_id sur fish.audio

**La clé API :**
1. Connecte-toi sur [fish.audio](https://fish.audio).
2. Va dans ton profil → **API** (ou directement la page « API keys »).
3. Crée une clé et copie-la 👉 c'est ta variable `FISH_API_KEY`.

**Les reference_id des 5 voix :**
1. Sur fish.audio, ouvre **My Voices** (tes clones vocaux).
2. Clique sur une voix : le `reference_id` apparaît dans la page (c'est aussi la suite de lettres/chiffres à la fin de l'URL, ex. `https://fish.audio/m/7f92xxxxxxxx/` → le reference_id est `7f92xxxxxxxx`).
3. Note les 5 reference_id, un par modèle.

## Étape 4 — Remplir le fichier de configuration

Ouvre [lib/config.ts](lib/config.ts) et remplace les placeholders :

- `REFERENCE_ID_MODELE_1` … `REFERENCE_ID_MODELE_5` → les reference_id de l'étape 3, et mets les vrais prénoms dans `name`.
- `111111111` … `555555555` → les IDs Telegram des 5 opérateurs (avec leurs prénoms).
- `999999999` → ton ID Telegram (admin).

⚠️ Ce fichier ne contient **aucun secret** (pas de token, pas de clé API) : il peut être mis sur GitHub sans risque.

## Étape 5 — Mettre le projet sur GitHub

1. Crée un compte sur [github.com](https://github.com) si besoin.
2. Clique **New repository**, nomme-le `fish-voice-bot`, choisis **Private**, puis **Create repository**.
3. Sur ton PC, dans le dossier du projet, ouvre un terminal et lance :

```bash
git init
git add .
git commit -m "Fish Voice Bot"
git branch -M main
git remote add origin https://github.com/TON_COMPTE/fish-voice-bot.git
git push -u origin main
```

(Remplace `TON_COMPTE` par ton nom d'utilisateur GitHub.)

## Étape 6 — Créer le projet sur Vercel

1. Crée un compte sur [vercel.com](https://vercel.com) en choisissant **Continue with GitHub** (le tier gratuit « Hobby » suffit).
2. Clique **Add New… → Project**.
3. Sélectionne le repo `fish-voice-bot` → **Import**.
4. Ne touche à rien (framework « Other » détecté automatiquement) et clique **Deploy**. Le premier déploiement peut afficher une erreur de bot tant que les variables ne sont pas configurées : c'est normal, on les ajoute juste après.

**Vérifier Fluid Compute (activé par défaut) :** dans le projet Vercel → **Settings → Functions** → la section **Fluid Compute** doit être **activée** (c'est le défaut pour les nouveaux projets). C'est ce qui permet au bot de continuer la génération audio après avoir répondu à Telegram. La durée max (60 s) est déjà configurée par le fichier `vercel.json`.

## Étape 7 — Ajouter Upstash Redis (Marketplace Vercel)

1. Dans ton projet Vercel, onglet **Storage** (ou **Integrations → Browse Marketplace**).
2. Choisis **Upstash** → **Redis** (Serverless DB) → plan **Free**.
3. Crée la base (région proche, ex. `eu-west-1`) et **connecte-la au projet** `fish-voice-bot`.
4. L'intégration ajoute automatiquement les variables `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN` au projet (selon la version de l'intégration elles peuvent s'appeler `KV_REST_API_URL` / `KV_REST_API_TOKEN` — le bot accepte les deux, rien à faire).

## Étape 8 — Configurer les variables d'environnement

Dans le projet Vercel → **Settings → Environment Variables**, ajoute (environnement **Production**, coche aussi Preview si proposé) :

| Nom | Valeur |
|---|---|
| `BOT_TOKEN` | le token de BotFather (étape 1) |
| `FISH_API_KEY` | la clé API fish.audio (étape 3) |
| `TELEGRAM_WEBHOOK_SECRET` | un mot de passe long que tu inventes, ex. `Xk7pQ2vN9mR4tW8zL5cB3fJ6` (lettres et chiffres uniquement) |

Les deux variables Upstash sont déjà là grâce à l'étape 7.

Ensuite **redéploie** pour prendre en compte les variables : onglet **Deployments** → menu `…` du dernier déploiement → **Redeploy**.

## Étape 9 — Enregistrer le webhook auprès de Telegram

Remplace `<BOT_TOKEN>`, `<projet>` et `<SECRET>` par tes valeurs (le `<SECRET>` = exactement la valeur de `TELEGRAM_WEBHOOK_SECRET`), puis colle cette commande dans un terminal (PowerShell ou autre) :

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<projet>.vercel.app/api/webhook&secret_token=<SECRET>&drop_pending_updates=true"
```

Réponse attendue :

```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

**Vérifier que le webhook est actif :**

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

Tu dois voir ton URL dans `"url"` et idéalement `"pending_update_count":0`. Si un champ `"last_error_message"` apparaît, il indique le problème (voir Dépannage).

**Bonus — afficher le menu des commandes dans Telegram :**

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setMyCommands" -H "Content-Type: application/json" -d "{\"commands\":[{\"command\":\"voix\",\"description\":\"Choisir la modèle\"},{\"command\":\"aide\",\"description\":\"Tags d'émotion et mode d'emploi\"}]}"
```

## Étape 10 — Tester

1. Ouvre ton bot dans Telegram (avec un compte **whitelisté** !) et envoie `/start`.
2. Choisis une modèle avec les boutons.
3. Envoie un texte, par exemple : `[whisper] Coucou toi... [excited] tu m'as manqué !`
4. Tu reçois la voice note en quelques secondes. 🎉

---

# Mises à jour

Chaque `git push` sur `main` redéploie automatiquement le bot sur Vercel. Pour ajouter/retirer un opérateur ou changer une voix : modifie [lib/config.ts](lib/config.ts), commit, push.

```bash
git add .
git commit -m "maj config"
git push
```

(Alternative sans GitHub : `npm i -g vercel` puis `vercel deploy --prod` dans le dossier du projet.)

# Vérifier que le projet compile (pour les développeurs)

```bash
npm install
npm run typecheck
```

# Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| Le bot ne répond à rien | Webhook non enregistré ou mauvais secret | Refais l'étape 9, vérifie avec `getWebhookInfo` |
| `last_error_message: "Wrong response..."` ou `401` | `TELEGRAM_WEBHOOK_SECRET` (Vercel) ≠ `secret_token` (setWebhook) | Mets exactement la même valeur des deux côtés, redéploie, refais `setWebhook` |
| Le bot ignore quelqu'un | Son ID n'est pas dans la whitelist | Ajoute l'ID dans [lib/config.ts](lib/config.ts) et push |
| « Crédits Fish Audio épuisés » | Plus de crédits sur le compte fish.audio | Recharger sur fish.audio |
| « reference_id invalide » | Mauvais reference_id dans la config | Revérifie l'étape 3 |
| Voice note jamais reçue, pas d'erreur | Fluid Compute désactivé | Settings → Functions → activer Fluid Compute, redéployer |
| Erreur `Variables Upstash Redis manquantes` | Intégration Upstash non connectée au projet | Refais l'étape 7 puis Redeploy |

# Sécurité

- Les secrets (`BOT_TOKEN`, `FISH_API_KEY`, etc.) vivent **uniquement** dans les variables d'environnement Vercel — jamais dans le code, jamais sur GitHub (le `.gitignore` exclut les fichiers `.env`).
- Chaque requête entrante est vérifiée via le header `X-Telegram-Bot-Api-Secret-Token`.
- Tout utilisateur hors whitelist est ignoré silencieusement.
