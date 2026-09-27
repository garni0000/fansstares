# FanBot Stars — chat IA + funnel PPV Telegram Stars (Supabase)

## 1. Supabase
1. Crée un projet sur supabase.com
2. **SQL Editor** → colle et exécute `supabase/schema.sql` (tables + bucket privé `galerie`)
3. **Project Settings > API** → récupère l'URL et la clé `service_role`

> **Mise à jour depuis une version précédente** : exécute dans Supabase > SQL Editor :
> `alter table fans add column if not exists status text default 'active';`

## 2. Lancement
```bash
npm install
cp .env.example .env   # SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_PASSWORD
npm start
```
Ouvre **http://localhost:3000** → connecte-toi avec ADMIN_PASSWORD.

## 3. Panneau admin
- **Funnel** : carte visuelle du tunnel de vente. Ajoute / supprime des étapes, choisis le type
  (teaser, média gratuit, PPV, discussion, fin), les médias de la galerie, le prix en Stars,
  et les branches « s'il achète → … / s'il n'achète pas → … ». Actif dès l'enregistrement.
- **Fans (CRM)** : liste de tous les fans avec leur niveau (phase 1 ou étape du funnel), statut, achats, Stars et dernière activité.
  Recherche + filtres (actifs / en pause / stoppés). Clique sur un fan pour voir toute la conversation,
  le **mettre en pause**, le **stopper**, le **réactiver**, le **déplacer vers une étape** ou le **supprimer**.
  En pause / stoppé : ses messages sont enregistrés mais la modèle ne répond plus (les achats restent comptés).
- **Étape Stop** (type d'étape dans le Funnel) : dernier message optionnel, puis la modèle ne répond plus à ce fan.
- **Persona** : nom, âge, bio, style, nombre de messages de phase 1 et consignes.
- **Paramètres** : token du bot, ton ID Telegram, clé OpenRouter, modèle IA.
  Stockés dans Supabase, secrets jamais réaffichés. Le bot redémarre tout seul quand tu changes le token.
- **Galerie** : glisse tes photos/vidéos (jpg, png, webp, mp4, mov, 50 Mo max) → envoyées dans le bucket privé Supabase.
  Tu les sélectionnes ensuite directement dans les étapes du Funnel.
- **Stats** : fans, PPV envoyés/payés, Stars, conversion.
- Bouton **Démarrer / Arrêter** le bot en haut à droite.
- **⏱️ Mode de réponse** (en haut) : Humain 15–20 s · Occupée 1–2 min · Très occupée 3–5 min.
  Si le fan envoie plusieurs messages pendant l'attente, la modèle répond une seule fois à l'ensemble.

## 4. Compte perso (Telegram Business)
Le bot peut répondre depuis ton compte Telegram perso (Premium requis) :
1. Compte perso → **Paramètres → Telegram Business → Chatbots** → ajoute ton bot, active « Répondre aux messages »
2. Choisis les discussions gérées et exclus tes proches
3. Panneau → Paramètres : le statut passe à « Connecté »
- Les fans qui écrivent à ton compte passent dans le même funnel / CRM.
- Si tu réponds toi-même à un fan, le bot se met en pause pour lui.
- Vérification 18+ : désactivée par défaut (option dans Paramètres, bot direct uniquement).
  Un fan qui dit avoir moins de 18 ans est stoppé automatiquement.

## 5. Dossier `galerie/`
Tu peux aussi déposer tes fichiers directement dans le dossier `galerie/` du projet :
ils sont envoyés automatiquement dans Supabase (au démarrage + dès qu'un fichier est ajouté).
Le nom du média = nom du fichier en minuscules sans accents : `Shooting Plage 01.jpg` → `shooting_plage_01`.
Supprimer un fichier du dossier ne le supprime pas de Supabase (utilise le bouton Supprimer).

## 6. Funnel (avancé)
Le funnel et la persona sont stockés dans Supabase (table `settings`).
`config/funnel.json` et `config/persona.json` ne servent que de valeurs de départ.
```json
"A3": { "type": "ppv", "stars": 150, "media": ["shooting_photo", "shooting_video"], ... }
```
- Phase 1 : discussion (onglet Persona)
- Phase 2 : `teaser_text` → `free_media` → `ppv` → `onBuy` (script B) / `onNoBuy` (script X) → `end`
- Modifs actives dès l'enregistrement dans le panneau : pas besoin de redémarrer.

Au premier envoi, le média est uploadé à Telegram depuis Supabase, puis son `file_id` est mis en cache → envois suivants instantanés.

## Commandes admin dans le bot (ton ID Telegram)
- `/stats` · `/reset` (repart de zéro pour tester)
- `/mode humain` · `/mode occupee` · `/mode tres` (change le délai de réponse depuis Telegram)

## Déploiement (Railway / VPS)
Variables : `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ADMIN_PASSWORD`, `PORT`. Tout le reste est dans Supabase.
