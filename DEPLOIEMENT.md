# Déployer le studio voix (jalon J1)

Tout se déploie depuis GitHub par le workflow [`deploy`](.github/workflows/deploy.yml) : rien à installer sur ton PC. Il crée l'application Fly, son stockage Tigris et sa base Postgres, pose les secrets, déploie le worker de synthèse puis l'API. Le worker tourne par défaut sur Fly en CPU (application `<FLY_APP>-worker`, joignable seulement par le réseau privé de Fly, éteinte au repos) ; la variable de dépôt `WORKER_BACKEND=modal` le met sur un GPU Modal à la place, plus rapide mais qui demande un moyen de paiement chez Modal.

## 1. Les comptes et les secrets (une seule fois)

Dans **GitHub → studio-voix → Settings → Secrets and variables → Actions → New repository secret** :

| Secret | Où le trouver |
| --- | --- |
| `FLY_API_TOKEN` | fly.io → Account → Access Tokens → *Create token* (type *Org deploy token*, organisation `personal`) |
| `MODAL_TOKEN_ID` et `MODAL_TOKEN_SECRET` *(seulement avec `WORKER_BACKEND=modal`)* | modal.com → Settings → API Tokens → *New token* (les deux valeurs s'affichent ensemble) |
| `OWNER_PASSWORD` | un mot de passe que tu choisis : il protège la page où tu autorises le connecteur |
| `EXPORTS_GITHUB_TOKEN` *(canal B, facultatif)* | github.com → Settings → Developer settings → Fine-grained token, accès *Contents: read and write* au seul dépôt privé `essayons-studio-exports` (à créer vide) |

Variables facultatives (onglet *Variables*) : `FLY_APP` si le nom `studio-voix-bilel` est pris, `EXPORTS_REPO` si le dépôt d'exports porte un autre nom.

Les secrets internes (`TOKEN_SECRET`, `API_KEY`) sont générés par le workflow au premier déploiement, `WORKER_TOKEN` à chaque déploiement ; aucun n'est jamais affiché. La base Postgres est créée chez Fly (`<FLY_APP>-db`, non gérée, une machine `shared-cpu-1x` et 1 Go) et rattachée à l'application ; un secret `DATABASE_URL` facultatif la remplace par une autre base (Neon par exemple).

## 2. Lancer le déploiement

**Actions → deploy → Run workflow.** Il se relance ensuite tout seul à chaque fusion sur `main`. À la fin, `https://<FLY_APP>.fly.dev/healthz` répond `{"ok":true}`.

## 3. Ajouter le connecteur dans Claude

**Claude → Réglages → Connecteurs → Ajouter un connecteur personnalisé**, URL : `https://<FLY_APP>.fly.dev/mcp`. Claude ouvre la page d'autorisation du studio : mot de passe `OWNER_PASSWORD`, et coche « créer et supprimer des voix » pour la première création de voix (tu pourras reconnecter sans la case ensuite).

## 4. Le canal des fichiers

Les outils rendent des URL signées sur le stockage Tigris, de la forme `https://<FLY_APP>-media.fly.storage.tigris.dev/…`. Deux façons de les rendre joignables depuis l'espace de travail de Claude :

- **Canal A** : ajouter `<FLY_APP>-media.fly.storage.tigris.dev` dans Claude → Réglages → Capacités → domaines autorisés. Rien d'autre à faire ; un domaine à toi (`media.<ton-domaine>`) pourra le remplacer plus tard avec la variable `MEDIA_PUBLIC_BASE`.
- **Canal B** : poser `EXPORTS_GITHUB_TOKEN`. `media_upload_init` rend alors la commande `gh release upload` et `media_get` (avec `channel: "github"`) la commande `gh release download`, sur le dépôt `essayons-studio-exports` ajouté à la session.

## Ce que ça coûte

- Fly : une machine `shared-cpu-1x` 1 Go toujours allumée, environ 6 $/mois, plus le stockage Tigris au volume.
- Worker Fly (par défaut) : une machine `performance-8x` 16 Go, facturée à la seconde seulement quand elle tourne, environ 0,36 € de l'heure. Elle démarre à la première demande (le modèle se charge en une minute environ) et s'éteint quelques minutes après la dernière. En CPU la synthèse est plus lente que le temps réel : `job_status` rend le facteur mesuré. Le coût est compté au tarif `GPU_EUR_PER_SECOND` (0,0001 €/s).
- Modal (`WORKER_BACKEND=modal`) : GPU L4 facturé à la seconde pendant que le conteneur tourne (génération plus 2 min d'inactivité avant extinction). `job_status` rend `gpu_seconds` et `cost_eur` (au tarif `GPU_EUR_PER_SECOND`, 0,00025 €/s par défaut, à caler sur la facture réelle). Le plafond du jour est `GPU_DAILY_CAP_EUR` (10 €).
- Postgres Fly non géré : une petite machine et 1 Go de volume, quelques dollars par mois. Les sauvegardes sont les instantanés quotidiens du volume ; Fly Managed Postgres (38 $/mois) les gère mieux si le service grossit.

## En local

```sh
npm ci
npm test            # 11 tests de bout en bout : API, MCP, OAuth, ffmpeg (worker GPU simulé)
npm run dev         # PGlite en mémoire, stockage dans .data/, pas de worker GPU
cd worker && pytest -q test_textprep.py
```
