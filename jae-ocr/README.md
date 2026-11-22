# JAE OCR (Tableau de bord & serveur de reconnaissance)

Tableau de bord web de gestion de la rencontre par équipes et service backend recevant les validations d'identité (locales ou de secours).

## Fonctionnalités (pour les utilisateurs)

- **Tableau de rencontre clair en 4 zones** : **Officiels**, **Équipe 1**, **Équipe 2** et **Non-affecté**, avec vue complète ou condensée.
- **Validation et placement automatiques** : les joueurs importés de Ten'Up attendent dans *Non-affecté* ; dès que leur pièce d'identité (CNI ou passeport) est scannée, la case *Pièce d'identité* se coche et leur fiche bascule automatiquement dans la colonne de leur équipe.
- **Protection contre les erreurs** : les noms de clubs importés de Ten'Up sont verrouillés (ils ne sont plus écrasés par un glisser-déposer) et il est impossible de déposer une joueuse ou un joueur dans la colonne de l'équipe adverse.
- **Contrôle réglementaire strict** : seuls les **CNI et passeports** sont acceptés (permis de conduire et titres de séjour refusés) ; une pièce d'identité seule sans licence ni présence dans la liste Ten'Up (ex. officiel) attend sa licence avant de créer une fiche.
- **Synchronisation multi-écrans** : chaque glisser-déposer, titre ou lien Ten'Up est partagé automatiquement entre tous les ordinateurs/tablettes connectés.
- **Gestion de rencontre** : lien cliquable vers la feuille Ten'Up, **Exporter / Importer une rencontre** (JSON), **Nouvelle rencontre** (archivage propre) et **Mode Debug** (`?debug=true`) isolé pour les essais.

---

## Détails techniques

### Endpoints principaux (`backend/app.py`)

- `POST /api/identite/direct` : **circuit court sans LLM ni photo** — reçoit `{ nom, prenom, ... }` extraits par MRZ valide sur Android, écrit `PID_<prenom>_<nom>_<uuid8>.json` dans `jae-scan-results` et retourne `matched: true/false`.
- `GET/POST /api/tenup/roster` : lit/enregistre `ROSTER_CURRENT.json` envoyé par l'extension Chrome (sans LLM).
- `POST /` : **fallback OCR serveur** déclenché par Eventarc GCS (`object.v1.finalized`) — ignore les événements antérieurs à `MATCH_RESET_AT.json` et les fichiers déjà `STATUS == done`, acquiert un verrou atomique `.LOCK` (`if_generation_match=0`), appelle **Vertex AI (`gemini-4-hydrogen`)** en JSON strict (`backend/prompt.txt`) avec retries `429`/`503`, refuse `non_autorise` (`permis_conduire`/`titre_sejour`).
- `GET /` & `GET /api/participants` : tableau web + API participants avec rapprochement Unicode (`nom`, `nom_usage`, prénoms multiples, inversions).
- `GET/POST /api/board-state` : persistance et synchronisation multi-machines (`BOARD_STATE.json`).
- `POST /api/upload-url` & `GET /api/scan-status/<object_name>` : Signed URL v4 GCS (5 min) et suivi asynchrone pour le fallback photo Android.
- `POST /api/reset-match` : archive les fichiers actifs sous `archive/<timestamp>/` et met à jour `MATCH_RESET_AT.json`.

### Variables d'environnement

| Variable | Défaut | Description |
| :--- | :--- | :--- |
| `GCP_PROJECT` | `alexismp-runner` | Projet GCP pour Vertex AI (`google-genai`, auth par compte de service IAM) |
| `VERTEX_LOCATION` | `global` | Région Vertex AI pour `gemini-4-hydrogen` |
| `GEMINI_MODEL` | `gemini-4-hydrogen` | Modèle Gemini utilisé en fallback OCR |
| `SCAN_BUCKET_NAME` | `jae-scan-bucket` | Bucket GCS des photos de secours |
| `RESULTS_BUCKET_NAME` | `jae-scan-results` | Bucket GCS des JSON, rosters, état du tableau et archives |
| `SCANNER_API_KEY` | *(optionnel)* | Clé API partagée (`X-API-Key` / `Bearer`) pour les endpoints d'écriture |

### Déploiement sur Cloud Run & rôles IAM

```bash
podman build --platform linux/amd64 \
  -t europe-west1-docker.pkg.dev/alexismp-runner/jae-identites/jae-ocr:latest \
  ./jae-ocr

podman push europe-west1-docker.pkg.dev/alexismp-runner/jae-identites/jae-ocr:latest

gcloud run deploy jae-ocr \
  --project alexismp-runner \
  --image europe-west1-docker.pkg.dev/alexismp-runner/jae-identites/jae-ocr:latest \
  --region europe-west1 \
  --allow-unauthenticated \
  --set-env-vars="GCP_PROJECT=alexismp-runner,VERTEX_LOCATION=global"
```

Rôles IAM requis sur le compte de service Cloud Run : `roles/aiplatform.user`, `roles/storage.objectAdmin`, `roles/iam.serviceAccountTokenCreator`.
