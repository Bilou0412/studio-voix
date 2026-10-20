# studio-voix

Studio voix « Essayons de comprendre » : un service hébergé, exposé à Claude par un connecteur MCP, qui transforme le script-guide en narration avec une voix clonée. Ce dépôt en est à son **jalon J1 — la voix parle français**.

```
Claude ──MCP (OAuth 2.1)──▶ API /v1 + serveur MCP (Fly) ──HTTP──▶ worker Chatterbox (Fly CPU, ou Modal GPU)
   │                              │  ffmpeg, Postgres (Fly)            │
   └──── URL signées (canal A) ───┴──── stockage Tigris ◀───────────────┘
         ou releases GitHub (canal B)
```

## Ce que fait J1

| Outil MCP | Endpoint | Rôle |
| --- | --- | --- |
| `media_upload_init` | `POST /v1/media` | prépare un dépôt : put_url signée (canal A), commande `gh release upload` (canal B), morceaux (canal C) ; dédoublonne par sha256 |
| `media_upload_chunk` | `PUT /v1/media/{id}/chunks/{n}` | canal de secours, petits fichiers |
| `media_upload_complete` | `POST /v1/media/{id}/complete` | vérifie sha256 et taille, mesure la durée |
| `media_get` | `GET /v1/media/{id}?variant=&channel=` | URL signée 1 h ; variantes `original`, `clean`, `preview` (MP3 128 kb/s) ; canal GitHub |
| `voice_create` | `POST /v1/voices` | consentement horodaté obligatoire, nettoyage de chaque extrait (passe-haut 75 Hz, débruitage, −20 LUFS, 24 kHz), phrase test |
| `voice_list` | `GET /v1/voices` | voix, références par ton, statut |
| `voice_preview` | `POST /v1/voices/{id}/preview` | fait dire un texte (la phrase test ou un bloc) avec les réglages de son ton ; rend durée, secondes GPU, facteur temps réel, coût |
| `job_status` | `GET /v1/jobs/{id}?wait=25` | suivi des jobs, long-polling 25 s |

Règles communes en place : clé d'idempotence sur tout ce qui crée, erreurs `{code, message, retryable, hint}`, plafond GPU par jour (`quota_exceeded`), journal d'audit des voix, portée `voices:write` accordée seulement si tu coches la case sur la page d'autorisation.

Le worker ([`worker/engine.py`](worker/engine.py), servi sur Fly en CPU par [`worker/server.py`](worker/server.py) ou sur Modal en GPU par [`worker/modal_app.py`](worker/modal_app.py)) prépare le texte (crochets retirés, nombres en lettres, une phrase par segment de 250 caractères au plus), synthétise avec Chatterbox Multilingual (`language_id="fr"`, seed enregistrée, filigrane Perth conservé), recolle les segments avec un fondu de 20 ms et une pause de 0,15 à 0,3 s selon la ponctuation.

## Le test de J1

Depuis la conversation, avec le seul connecteur :

1. `media_upload_init` pour `voix_echantillon.mp3`, envoi par le canal disponible, `media_upload_complete`.
2. `voice_create` avec ce `media_id` et le consentement « C'est ma voix et j'autorise son clonage. », puis `job_status` (`wait_seconds: 25`) jusqu'à `succeeded`.
3. `voice_preview` avec le texte et le ton du bloc 0.1, puis `job_status` : le résultat donne l'URL du WAV, sa durée, les secondes GPU, le facteur temps réel et le coût.
4. Tu écoutes et tu valides l'accent ; on note la vitesse et le coût réels.

## Pas encore là

Ce qui appartient aux jalons suivants : projets, blocs, import et diff, lexique, prises multiples, alignement mot à mot (WhisperX), contrôle qualité (WER, similarité ECAPA, artefacts), mix et mastering, prises humaines, bibliothèque de médias, flux SSE, page `/status`. La vérification d'identité vocale (similarité ≥ 0,75 avec l'enrôlement) arrive avec `voice_add_reference`, la suppression totale d'une voix avec la gestion des voix.

Déploiement : [DEPLOIEMENT.md](DEPLOIEMENT.md).
