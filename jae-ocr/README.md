# JAE OCR

Service backend (Cloud Run) qui effectue la reconnaissance visuelle de documents d'identité et de licences FFT via Gemini (`gemini-4-hydrogen`), expose le tableau web de suivi de rencontre et fournit un endpoint de Signed URL GCS pour l'upload direct depuis l'application Android.

## Documents pris en charge

- **Pièces d'identité** : CNI française ancien format (ID-2 / MRZ TD2), CNI française nouveau format (ID-1), passeports français et étrangers (translittération latine, croisement VIZ + MRZ, `nom_usage`, prénoms multiples).
- **Licences FFT** : attestation de licence complète (`attestation_fft`) et capture/photo d'écran Ten'Up (`tenup_ecran`, gestion des champs manquants à `null` et normalisation des saisons `2025/2026` → `2026`).

## Endpoints

- `POST /` : réception des événements Eventarc GCS (`object.v1.finalized`), verrou atomique `.LOCK` (`if_generation_match=0`), analyse `gemini-4-hydrogen` en JSON strict (`response_mime_type="application/json"`), sauvegarde dans `jae-scan-results`.
- `GET /` : interface web de gestion de la rencontre (glisser-déposer Officiels / Équipe 1 / Équipe 2 / Non-affectés).
- `GET /api/participants` : liste JSON des participants (y compris les licences Ten'Up incomplètes avec `licence_incomplete: true`) avec rapprochement Unicode (`nom`, `nom_usage`, prénoms multiples) contre les fichiers `PID_*.json`.
- `POST /api/upload-url` : génère une **GCS Signed URL v4** (valable 5 min) vers `jae-scan-bucket` pour permettre l'upload direct depuis Android sans passer par `jae-scanner`. Protégé par `SCANNER_API_KEY` si définie.

## Variables d'environnement

| Variable | Défaut | Description |
| :--- | :--- | :--- |
| `GOOGLE_API_KEY` | *(requis)* | Clé API Gemini (lue depuis `.env`, ne jamais commiter) |
| `GEMINI_MODEL` | `gemini-4-hydrogen` | Modèle Gemini utilisé pour l'OCR |
| `SCAN_BUCKET_NAME` | `jae-scan-bucket` | Bucket GCS source des images |
| `RESULTS_BUCKET_NAME` | `jae-scan-results` | Bucket GCS des résultats JSON et verrous `.LOCK` |
| `SCANNER_API_KEY` | *(optionnel)* | Clé API partagée (`X-API-Key` / `Bearer`) pour `POST /api/upload-url` |

## Déploiement sur Cloud Run

```bash
# 1. Construire l'image (Apple Silicon -> linux/amd64 pour Cloud Run)
podman build --platform linux/amd64 \
  -t europe-west1-docker.pkg.dev/alexismp-runner/jae-identites/jae-ocr:latest \
  ./jae-ocr

# 2. Pousser vers Artifact Registry
podman push europe-west1-docker.pkg.dev/alexismp-runner/jae-identites/jae-ocr:latest

# 3. Déployer sur Cloud Run (avec GOOGLE_API_KEY lue depuis .env)
gcloud run deploy jae-ocr \
  --project alexismp-runner \
  --image europe-west1-docker.pkg.dev/alexismp-runner/jae-identites/jae-ocr:latest \
  --region europe-west1 \
  --allow-unauthenticated \
  --set-env-vars="GOOGLE_API_KEY=<VALEUR_DEPUIS_.ENV>"
```

## Déclencheur Eventarc & permissions IAM

```bash
gcloud eventarc triggers create jae-ocr-trigger \
  --location=eu \
  --destination-run-service=jae-ocr \
  --destination-run-region=europe-west1 \
  --event-filters="type=google.cloud.storage.object.v1.finalized" \
  --event-filters="bucket=jae-scan-bucket" \
  --service-account="2500276981-compute@developer.gserviceaccount.com"
```

Rôles requis sur le compte de service Cloud Run :
- `roles/storage.objectAdmin` (lecture `jae-scan-bucket`, écriture/suppression `jae-scan-results`)
- `roles/iam.serviceAccountTokenCreator` (si utilisation de `POST /api/upload-url` pour signer les URLs GCS)
