# Veille

Agrégateur de veille technologique auto-hébergé (RSS / Atom / RSS 1.0), multi-utilisateurs : **chaque compte gère ses propres flux** (ajout, import / export OPML, modification, suppression). Node.js + SQLite, déployé avec Docker.

## Fonctionnalités

- **Lecture** : articles groupés par jour (Hier / Aujourd'hui), période au choix (aujourd'hui, hier + aujourd'hui, 7 j, 30 j), recherche (touche `/`), filtres par catégorie puis par source.
- **Lu / non lu** : bouton ✓ par article, « Tout marquer lu » sur ce qui est affiché avec Annuler, réaffichage des articles lus par flux ou par catégorie.
- **Synchronisation entre appareils**, avec file d'attente hors ligne et mise à jour automatique au retour sur l'onglet.
- **Flux par compte** : détection automatique du flux à partir de l'adresse d'un site, catégories personnelles, test, activation, import / export OPML.
- **Collecte côté serveur** : une adresse suivie par plusieurs comptes n'est téléchargée qu'une fois, avec `ETag` / `If-Modified-Since`.
- **Comptes et rôles**, double authentification TOTP, thème clair / sombre, interface mobile installable sur l'écran d'accueil.
- **Sauvegardes** : copie quotidienne automatique, export par compte, archive complète chiffrée.

## Installation

```bash
git clone https://github.com/xaviergregor/veille.git
cd veille
cp .env.example .env
vim .env                  # ADMIN_PASSWORD (8 caractères min.) — sert uniquement au premier démarrage
docker compose up -d --build
docker compose logs -f    # « Compte administrateur « admin » créé. » puis la première collecte
```

Interface : `http://serveur:3000`. Au départ, aucun compte n'a de flux : les ajouter depuis **Mes flux**, ou importer `exemples/flux-techno.opml` (une quarantaine de flux techno francophones et anglophones, rangés par catégorie) depuis **Mes flux → Importer OPML**.

Le fichier `.env` doit exister **avant** le premier `docker compose up` : il est monté en lecture seule pour la sauvegarde complète, et Docker créerait sinon un dossier à sa place.

### Mise à jour

```bash
git pull
docker compose up -d --build
```

Le dossier `data/` (base, clé, sauvegardes) n'est pas versionné et n'est jamais touché.

### Derrière un reverse proxy

Dans `.env` :

```
TRUST_PROXY=1      # vraie IP client dans les logs et pour l'anti-bruteforce
COOKIE_SECURE=1    # cookies « Secure » : l'application n'est servie qu'en HTTPS
```

Avec `COOKIE_SECURE=1`, la connexion ne fonctionne plus en HTTP direct sur `:3000` : passer par l'adresse HTTPS. Dans ce cas, il est aussi préférable de n'écouter qu'en local dans `docker-compose.yml` : `"127.0.0.1:3000:3000"`.

## Double authentification

Code à 6 chiffres (TOTP) compatible avec Aegis, 2FAS, Google / Microsoft Authenticator, Proton Authenticator…

- **Chaque compte** l'active dans le menu du compte → *Mon compte* (QR code + saisie manuelle de la clé).
- **L'administrateur** peut l'imposer à un compte (*Comptes* → modifier → « Imposer la double authentification ») : le QR code est présenté à sa prochaine connexion. Il peut aussi la **réinitialiser** (téléphone perdu), ce qui ferme les sessions du compte.
- `ADMIN_REQUIRE_2FA=1` l'impose au compte administrateur créé au premier démarrage.
- **« Se souvenir de cet appareil »** pendant `TRUST_DAYS` jours (30 par défaut, 0 pour désactiver). Changer de mot de passe, désactiver ou réinitialiser la 2FA, ou « Oublier les appareils mémorisés » les révoque tous.
- Les secrets sont chiffrés en base (AES-256-GCM, clé dérivée de `SECRET_KEY`) ; un code ne sert qu'une fois ; 5 codes faux → blocage 15 min.

## Logo (optionnel)

La pastille violette peut être remplacée par **votre logo** (en-tête et page de connexion) : déposez dans `branding/`, à côté du `docker-compose.yml` :

- `branding/logo.svg` (ou `.png`, `.webp`, `.jpg`) — le logo ;
- `branding/logo-dark.*` — **facultatif**, variante pour le thème sombre (sinon le logo est passé en blanc automatiquement).

Pris en compte au rechargement de la page, sans redémarrer.

## Réglages (.env)

| Variable | Défaut | Rôle |
|---|---|---|
| `SECRET_KEY` | générée | Signe les cookies et chiffre les secrets 2FA (`openssl rand -hex 32`). Vide : générée dans `data/secret.key` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / — | Compte créé au premier démarrage |
| `ADMIN_REQUIRE_2FA` | `0` | `1` : 2FA imposée à ce compte dès la première connexion |
| `TRUST_PROXY` | `0` | `1` derrière un reverse proxy |
| `COOKIE_SECURE` | `0` | `1` si servi uniquement en HTTPS |
| `SESSION_HOURS` | `720` | Durée de session (prolongée à chaque visite) |
| `TRUST_DAYS` | `30` | Durée « se souvenir de cet appareil » (0 = désactivé) |
| `FETCH_INTERVAL` | `30` | Minutes entre deux collectes (5 à 1440) |
| `FETCH_CONCURRENCY` | `6` | Flux téléchargés en parallèle |
| `RETENTION_DAYS` | `30` | Durée de conservation des articles (et de l'état « lu ») |
| `BACKUP_DAYS` | `30` | Copies quotidiennes conservées |
| `MAX_FEEDS_PER_USER` | `300` | Nombre maximum de flux par compte |
| `ALLOW_PRIVATE_FEEDS` | `0` | `1` : autorise les flux hébergés sur le réseau local |
| `TZ` | `Europe/Paris` | Fuseau du conteneur |

## Flux par compte

- Chaque compte ne voit que **ses** flux et leurs articles ; il les nomme et les range dans ses propres catégories.
- Une même adresse suivie par plusieurs comptes n'est **téléchargée qu'une fois** ; quand plus personne ne la suit, le flux et ses articles sont supprimés.
- Import OPML : NetNewsWire, Feedly, Inoreader, Thunderbird… Les flux déjà suivis sont ignorés. Export OPML de ses flux à tout moment.
- **Réafficher un seul flux** : dans *Mes flux*, l'œil remet en non lu les articles lus de ce flux (avec Annuler), sans toucher aux autres. Dans *Actualités*, cliquer sur le nom de la source d'une carte filtre sur ce flux, puis « Les remettre en non lu » ne concerne que lui (idem pour une catégorie).
- **Collecter** relance immédiatement le téléchargement de ses flux (au plus une fois par minute) ; sinon la collecte automatique passe toutes les `FETCH_INTERVAL` minutes.
- Le serveur refuse les adresses du réseau interne (127.0.0.1, 192.168.x, 10.x…), pour qu'un compte ne puisse pas s'en servir pour sonder votre réseau. `ALLOW_PRIVATE_FEEDS=1` les autorise (flux d'un service du réseau local, par exemple).

## Rôles

- **Lecteur** : gère ses flux, lit, marque lu / non lu (synchronisé entre ses appareils).
- **Administrateur** : en plus, gère les comptes d'accès (il ne voit pas les flux des autres).

## Données

Tout est dans le dossier **`data/`**, à côté du `docker-compose.yml` :

```
data/
├── veille.db       # base SQLite : comptes, flux, articles (30 j), état lu / non lu
└── secret.key      # seulement si SECRET_KEY est vide dans .env
```

Au démarrage, le conteneur donne ce dossier à son utilisateur interne (`node`, uid 1000), puis abandonne les droits root : pas de `chown` à faire à la main. Pour le lire depuis l'hôte : `sudo sqlite3 data/veille.db` ou `sudo ls -l data/`.

Pour le placer ailleurs (un autre disque par exemple), changer la ligne du compose : `- /srv/veille-data:/app/data`.

## Sauvegardes

```
data/backups/
├── AAAA-MM-JJ/            # copie quotidienne automatique (veille.db + secret.key), BACKUP_DAYS jours (30)
└── comptes-supprimes/     # flux et articles lus des comptes supprimés (.json, restaurables)
```

1. **Copie quotidienne** : faite au démarrage puis vérifiée toutes les heures (copie cohérente, même pendant une collecte). *Comptes › Sauvegardes* montre les copies et permet d'en faire une tout de suite.
2. **Par compte** : menu du compte › *Sauvegarder / restaurer* → fichier `.json` (flux avec leurs noms, catégories, état actif, et articles lus). L'admin fait de même pour n'importe quel compte (icône de la ligne, tracé dans les logs). Restauration en *Ajouter* (fusion sans doublons) ou *Remplacer tout*. Le `.json` est aussi accepté par *Mes flux › Importer*. L'export OPML reste là pour passer à un autre lecteur RSS.
3. **Sauvegarde complète chiffrée** (admin) : *Comptes › Sauvegardes* → archive **ZIP AES-256** protégée par une phrase de passe (10 caractères min., 12+ recommandés) : `data/veille.db`, `data/secret.key`, `branding/`, `config/.env`, `config/docker-compose.yml`, `LISEZ-MOI.txt`. Elle contient la `SECRET_KEY` et suffit à tout reconstruire : garder la phrase de passe à part. S'ouvre avec 7-Zip ou Keka. `data/backups/` n'y est pas.

Pour que `.env` et `docker-compose.yml` soient dans l'archive, ils sont montés en lecture seule (déjà prévu dans le `docker-compose.yml` fourni).

**Restaurer une sauvegarde complète** (sur le serveur) :

```bash
7z x sauvegarde-veille-….zip            # demande la phrase de passe
docker compose down
cp -r data branding ./ && cp config/.env ./.env    # docker-compose.yml : reprendre celui de l'archive ou garder le vôtre
docker compose up -d --build
```

**Revenir à une copie quotidienne** : `docker compose down`, copier `data/backups/AAAA-MM-JJ/veille.db` (et `secret.key`) dans `data/`, supprimer `data/veille.db-wal` et `data/veille.db-shm`, `docker compose up -d`.

## Sécurité

- Mots de passe hachés (scrypt), sessions par cookie `HttpOnly` / `SameSite=Lax` (`Secure` avec `COOKIE_SECURE=1`), jetons stockés hachés.
- Double authentification TOTP optionnelle ou imposée (voir plus haut).
- Blocage 15 min après 5 échecs de connexion (par IP + identifiant) ou 5 codes 2FA faux.
- Toute modification exige une requête JSON (protection CSRF), CSP stricte, aucune donnée des flux n'est interprétée comme du HTML.
- Flux : http / https uniquement, adresses internes refusées (vérifiées à la connexion, redirections comprises), 4 Mo et 15 s maximum par téléchargement.

## Développement

```bash
npm install
npm test                                              # tests du lecteur de flux et de l'OPML
DATA_DIR=./data ADMIN_PASSWORD=motdepasse npm start   # Node ≥ 22.13
```

### API (cookie de session)

`GET /api/me` · `GET /api/articles?since=<ms>` · `POST /api/read {ids, read}` · `POST /api/refresh` ·
`GET|POST /api/feeds` · `PATCH|DELETE /api/feeds/:id` · `POST /api/feeds/:id/refresh` · `POST /api/feeds/probe {url}` ·
`POST /api/feeds/import {opml}` · `GET /api/feeds/export.opml` · `GET|POST /api/users` · `PATCH|DELETE /api/users/:id` ·
`POST /api/me/password` · `POST /api/login/2fa` · `POST /api/2fa/setup|enable|disable` · `POST /api/me/forget-devices` · `GET /api/health` (publique)
