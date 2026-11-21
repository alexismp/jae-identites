**Note importante :** Ce projet est un développement personnel et n'est en aucun cas affilié à la Fédération Française de Tennis (FFT). L'objectif de cet outil est uniquement de proposer une solution pour la phase de vérification des identités lors des rencontres par équipe.

# JAE Identités

Suite d'outils permettant aux Juges-Arbitres par Équipe (JAE) de scanner et vérifier rapidement les pièces d'identité (CNI française ancien/nouveau format, passeports français et étrangers) et les licences FFT (attestations de licence et captures d'écran Ten'Up) lors d'une rencontre par équipe.

## Modules

| Module | Rôle | Stack | Documentation |
| :--- | :--- | :--- | :--- |
| **`jae-scanner`** | Application web mobile pour capturer les documents via le navigateur et les envoyer vers Cloud Storage | Python, Flask, HTML/JS, Cloud Run | [jae-scanner/README.md](jae-scanner/README.md) |
| **`jae-ocr`** | Backend OCR déclenché par Eventarc + tableau web de gestion de la rencontre + endpoint Signed URL | Python, Flask, Gemini (`gemini-4-hydrogen`), GCS, Cloud Run | [jae-ocr/README.md](jae-ocr/README.md) |
| **`jae-scanner-android`** | Application Android native (module dédié dans ce dépôt) avec CameraX, flash/torche, double mode Identité/Ten'Up et analyse qualité on-device | Kotlin, Jetpack Compose, CameraX, ML Kit (+ Gemini Nano) | [jae-scanner-android/README.md](jae-scanner-android/README.md) |

## Flux de travail

1. Le JAE capture un document depuis **JAE Scanner** (web mobile) ou **JAE Scanner Android**.
2. L'image JPEG est téléversée dans le bucket GCS `jae-scan-bucket` avec un nom unique horodaté + UUID (via `POST /scan` sur `jae-scanner` ou directement via Signed URL v4 fournie par `POST /api/upload-url` sur `jae-ocr`).
3. Un déclencheur Eventarc (`google.cloud.storage.object.v1.finalized`) invoque **JAE OCR** sur Cloud Run.
4. **JAE OCR** pose un verrou atomique `.LOCK` (`if_generation_match=0`), analyse l'image avec **Gemini (`gemini-4-hydrogen`)** en JSON strict (reconnaissance sémantique des CNI, passeports, attestations FFT et écrans Ten'Up) et enregistre le résultat dans `jae-scan-results` (`{LIC|PID|UNKNOWN}_<prenom>_<nom>_<uuid8>.json`).
5. La page web de **JAE OCR** (`GET /` + polling `GET /api/participants`) affiche les fiches de participants (y compris les écrans Ten'Up incomplets avec `licence_incomplete: true`) et coche automatiquement `id_checked` via un rapprochement Unicode tolérant (`nom`, `nom_usage`, prénoms multiples, inversions).

## Gestion des doublons & concurrence

- **Zéro collision de fichiers** : chaque image uploadée et chaque fichier résultat JSON inclut un identifiant UUID court (`8` caractères hexadécimaux), évitant tout écrasement lors de scans simultanés ou rapprochés.
- **Déduplication dans l'interface** : si une même licence est scannée plusieurs fois, les deux fichiers JSON sont conservés dans `jae-scan-results`, mais `GET /api/participants` indexe par numéro de licence (ou `TEMP_<nom>_<prenom>` si la licence manque sur Ten'Up) afin de n'afficher qu'une fiche par joueur.
- **Verrou `.LOCK` atomique** : l'acquisition du verrou côté GCS utilise la précondition `if_generation_match=0`, ce qui protège contre les doublons Eventarc et les accès concurrents multi-threads (`gunicorn --threads 8`).
- **Sécurité optionnelle** : les endpoints d'upload (`POST /scan` et `POST /api/upload-url`) peuvent être protégés par la variable d'environnement `SCANNER_API_KEY` (`X-API-Key` ou `Authorization: Bearer`).
