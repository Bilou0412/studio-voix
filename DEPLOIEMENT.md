# Déployer le studio voix (jalon J1)

Tout se déploie depuis GitHub par le workflow [`deploy`](.github/workflows/deploy.yml) : rien à installer sur ton PC. Il crée l'application Fly et son stockage Tigris, pose les secrets, déploie le worker GPU sur Modal puis l'API.

## 1. Les comptes et les secrets (une seule fois)

Dans **GitHub → studio-voix → Settings → Secrets and variables → Actions → New repository secret** :

| Secret | Où le trouver |
| --- | --- |
| `FLY_API_TOKEN` | fly.io → Account → Access Tokens → *Create token* (type *Org deploy token*, organisation `personal`) |
| `MODAL_TOKEN_ID` et `MODAL_TOKEN_SECRET` | modal.com → Settings → API Tokens → *New token* (les deux valeurs s'affichent ensemble) |
| `DATABASE_URL` | neon.tech → nouveau projet `studio-voix`, région Frankfurt → *Connection string* (gratuit) |
| `OWNER_PASSWORD` | un mot de passe que tu choisis : il protège la page où tu autorises le connecteur |
| `EXPORTS_GITHUB_TOKEN` *(canal B, facultatif)* | github.com → Settings → Developer settings → Fine-grained token, accès *Contents: read and write* au seul dépôt privé `essayons-studio-exports` (à créer vide) |

Variables facultatives (onglet *Variables*) : `FLY_APP` si le nom `studio-voix-bilel` est pris, `EXPORTS_REPO` si le dépôt d'exports porte un autre nom.

Les secrets internes (`TOKEN_SECRET`, `API_KEY`, `WORKER_TOKEN`) sont générés par le workflow au premier déploiement et ne sont jamais affichés.

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
- Modal : GPU L4 facturé à la seconde pendant que le conteneur tourne (génération plus 2 min d'inactivité avant extinction). `job_status` rend `gpu_seconds` et `cost_eur` (au tarif `GPU_EUR_PER_SECOND`, 0,00025 €/s par défaut, à caler sur la facture réelle). Le plafond du jour est `GPU_DAILY_CAP_EUR` (10 €).
- Neon : gratuit à ce volume.

## En local

```sh
npm ci
npm test            # 11 tests de bout en bout : API, MCP, OAuth, ffmpeg (worker GPU simulé)
npm run dev         # PGlite en mémoire, stockage dans .data/, pas de worker GPU
cd worker && pytest -q test_textprep.py
```
