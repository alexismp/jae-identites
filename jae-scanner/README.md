# JAE Scanner (Web mobile de secours)

Application web mobile permettant de scanner une pièce d'identité ou une attestation de licence FFT depuis le navigateur de n'importe quel smartphone, sans avoir à installer l'application Android.

## Fonctionnalités (pour les utilisateurs)

- **Authentification Google OAuth obligatoire** : la caméra et le scan sont bloqués tant que le Juge-Arbitre ne s'est pas connecté avec son compte Google approuvé.
- **Affichage de la rencontre en cours** : un bandeau sous la zone de capture indique clairement les deux équipes et l'identifiant `#<matchId>` de la rencontre active, avec boutons d'actualisation et de déconnexion.
- **Aucune installation requise** : s'ouvre directement dans le navigateur mobile (iOS ou Android) pour dépanner un JAE ou un capitaine.
- **Cadre optimisé pour le mode paysage** : la zone de capture occupe l'écran sans avoir à faire défiler la page (le logo **JAE Identités** reste discret en pied de page).
- **Routage automatique vers la rencontre active** : chaque photo capturée est vérifiée côté serveur via le jeton Firebase du JAE puis routée vers sa rencontre active (`m_<matchId>/...`) dans Firestore.

> **Conseil :** Sur Android, privilégiez l'application native [JAE Scanner Android](../jae-scanner-android/README.md), qui lit les CNI et passeports localement **sans envoyer de photo ni appeler de LLM**, offre le contrôle de la torche et rejette immédiatement les pièces non autorisées.

---

## Détails techniques

### Architecture (`Python`, `Flask`, `HTML/JS`, `Cloud Run`)

- **Authentification & capture navigateur** (`static/js/script.js`, `static/js/firebase-config.js`, `backend/templates/index.html`) : Firebase Auth (Google OAuth uniquement), appel à `GET /api/me` sur `jae-ocr` pour afficher la rencontre active sous la zone de capture, `getUserMedia` en mode paysage, ratio carte ID-1 (`1.586`), export JPEG.
- **Validation & upload authentifié** (`POST /scan` dans `backend/app.py`) :
  - Vérification obligatoire du jeton Firebase `Authorization: Bearer <idToken>` auprès de `jae-ocr /api/me` (`401` si non connecté, `403` si compte non approuvé).
  - Validation Pillow de l'image reçue (`400` si vide ou corrompue).
  - Routage isolé par rencontre : `m_<matchId>/YYYY-MM-DD_HH-MM-SS-<uuid8>-<nom_sûr>`.
  - Erreur HTTP `502` explicite si l'écriture dans Cloud Storage échoue.

### Variables d'environnement

| Variable | Défaut | Description |
| :--- | :--- | :--- |
| `JAE_OCR_URL` | `https://jae-ocr-2500276981.europe-west1.run.app` | URL du backend `jae-ocr` utilisé pour vérifier la session et la rencontre active |
| `SCAN_BUCKET_NAME` | `jae-scan-bucket` | Bucket GCS de destination des images |
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
