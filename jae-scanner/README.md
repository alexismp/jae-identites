# JAE Scanner (Web mobile)

Application web mobile permettant de capturer un document (pièce d'identité ou licence FFT) depuis le navigateur d'un smartphone et de le téléverser dans le bucket Cloud Storage `jae-scan-bucket` pour traitement par `jae-ocr`.

> **Note :** Pour une expérience native avec contrôle du flash/torche et analyse de qualité on-device, voir [jae-scanner-android/README.md](../jae-scanner-android/README.md).

## Fonctionnalités

- **Capture caméra navigateur** (`getUserMedia`, mode paysage, ratio carte ID-1 `1.586`, export JPEG haute qualité).
- **Validation & upload fiable** (`POST /scan`) :
  - Validation Pillow de l'image reçue (`400` si vide ou corrompue).
  - Nom de fichier unique anti-collision : `YYYY-MM-DD_HH-MM-SS-<uuid8>-<nom_sûr>`.
  - Remontée explicite d'erreur HTTP `502` si l'upload vers Cloud Storage échoue.
  - Protection optionnelle par clé API partagée (`SCANNER_API_KEY` via `X-API-Key` ou `Bearer`).

## Variables d'environnement

| Variable | Défaut | Description |
| :--- | :--- | :--- |
| `SCAN_BUCKET_NAME` | `jae-scan-bucket` | Bucket GCS de destination des images |
| `SCANNER_API_KEY` | *(optionnel)* | Clé API partagée requise sur `POST /scan` si définie |
| `PORT` | `8080` | Port HTTP d'écoute (Gunicorn en conteneur, `5001` en local) |

## Déploiement sur Cloud Run

```bash
# 1. Construire l'image (Apple Silicon -> linux/amd64 pour Cloud Run)
podman build --platform linux/amd64 \
  -t europe-west1-docker.pkg.dev/alexismp-runner/jae-identites/jae-scanner:latest \
  ./jae-scanner

# 2. Pousser vers Artifact Registry
podman push europe-west1-docker.pkg.dev/alexismp-runner/jae-identites/jae-scanner:latest

# 3. Déployer sur Cloud Run
gcloud run deploy jae-scanner \
  --project alexismp-runner \
  --image europe-west1-docker.pkg.dev/alexismp-runner/jae-identites/jae-scanner:latest \
  --region europe-west1 \
  --allow-unauthenticated
```

## Développement local

```bash
cd jae-scanner/backend
python3 app.py
# Interface disponible sur http://localhost:5001
```
