# JAE Scanner (Web mobile de secours)

Application web mobile permettant de scanner une pièce d'identité ou une attestation de licence FFT depuis le navigateur de n'importe quel smartphone, sans avoir à installer l'application Android.

## Fonctionnalités (pour les utilisateurs)

- **Aucune installation requise** : s'ouvre directement dans le navigateur mobile (iOS ou Android) pour dépanner un JAE ou un capitaine.
- **Cadre optimisé pour le mode paysage** : la zone de capture occupe tout l'écran sans avoir à faire défiler la page (le logo **JAE Identités** reste discret en pied de page).
- **Envoi direct vers le tableau de bord** : chaque photo capturée est transmise au serveur `jae-ocr` pour reconnaissance et mise à jour automatique du tableau de rencontre.

> **Conseil :** Sur Android, privilégiez l'application native [JAE Scanner Android](../jae-scanner-android/README.md), qui lit les CNI et passeports localement **sans envoyer de photo ni appeler de LLM**, offre le contrôle de la torche et rejette immédiatement les pièces non autorisées.

---

## Détails techniques

### Architecture (`Python`, `Flask`, `HTML/JS`, `Cloud Run`)

- **Capture navigateur** (`static/js/script.js`, `backend/templates/index.html`) : `getUserMedia`, mode paysage, ratio carte ID-1 (`1.586`), export JPEG.
- **Validation & upload fiable** (`POST /scan` dans `backend/app.py`) :
  - Validation Pillow de l'image reçue (`400` si vide ou corrompue).
  - Nom de fichier unique anti-collision : `YYYY-MM-DD_HH-MM-SS-<uuid8>-<nom_sûr>`.
  - Erreur HTTP `502` explicite si l'écriture dans Cloud Storage échoue.
  - Protection optionnelle par clé API partagée (`SCANNER_API_KEY` via `X-API-Key` ou `Bearer`).

### Variables d'environnement

| Variable | Défaut | Description |
| :--- | :--- | :--- |
| `SCAN_BUCKET_NAME` | `jae-scan-bucket` | Bucket GCS de destination des images |
| `SCANNER_API_KEY` | *(optionnel)* | Clé API partagée requise sur `POST /scan` si définie |
| `PORT` | `8080` | Port HTTP d'écoute (Gunicorn en conteneur, `5001` en local) |

### Déploiement sur Cloud Run & développement local

```bash
podman build --platform linux/amd64 \
  -t europe-west1-docker.pkg.dev/alexismp-runner/jae-identites/jae-scanner:latest \
  ./jae-scanner

podman push europe-west1-docker.pkg.dev/alexismp-runner/jae-identites/jae-scanner:latest

gcloud run deploy jae-scanner \
  --project alexismp-runner \
  --image europe-west1-docker.pkg.dev/alexismp-runner/jae-identites/jae-scanner:latest \
  --region europe-west1 \
  --allow-unauthenticated
```

```bash
cd jae-scanner/backend
python3 app.py   # http://localhost:5001
```
