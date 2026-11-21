**Note importante :** Ce projet est un développement personnel et n'est en aucun cas affilié à la Fédération Française de Tennis (FFT). L'objectif de cet outil est uniquement de proposer une solution pour la phase de vérification des identités lors des rencontres par équipe.

# JAE Identités

Suite d'outils permettant aux Juges-Arbitres par Équipe (JAE) de scanner et vérifier rapidement les pièces d'identité (CNI française ancien/nouveau format, passeports français et étrangers) et les licences FFT (attestations de licence et captures d'écran Ten'Up) lors d'une rencontre par équipe.

## Modules

| Module | Rôle | Stack | Documentation |
| :--- | :--- | :--- | :--- |
| **`jae-scanner`** | Application web mobile pour capturer les documents via le navigateur et les envoyer vers Cloud Storage | Python, Flask, HTML/JS, Cloud Run | [jae-scanner/README.md](jae-scanner/README.md) |
| **`jae-ocr`** | Backend OCR déclenché par Eventarc + tableau web de gestion de la rencontre + endpoint Signed URL | Python, Flask, Gemini (`gemini-4-hydrogen`), GCS, Cloud Run | [jae-ocr/README.md](jae-ocr/README.md) |
| **`jae-scanner-android`** | Squelette d'application Android native (destiné à un dépôt GitHub dédié) avec CameraX, flash/torche et analyse qualité on-device | Kotlin, Jetpack Compose, CameraX, ML Kit (+ Gemini Nano) | [jae-scanner-android/README.md](jae-scanner-android/README.md) |

## Flux de travail

1. Le JAE capture un document depuis **JAE Scanner** (web mobile) ou **JAE Scanner Android**.
2. L'image JPEG est téléversée dans le bucket GCS `jae-scan-bucket` avec un nom unique horodaté + UUID (via `POST /scan` sur `jae-scanner` ou directement via Signed URL v4 fournie par `POST /api/upload-url` sur `jae-ocr`).
3. Un déclencheur Eventarc (`google.cloud.storage.object.v1.finalized`) invoque **JAE OCR** sur Cloud Run.
4. **JAE OCR** pose un verrou atomique `.LOCK` (`if_generation_match=0`), analyse l'image avec **Gemini (`gemini-4-hydrogen`)** en JSON strict (reconnaissance sémantique des CNI, passeports, attestations FFT et écrans Ten'Up) et enregistre le résultat dans `jae-scan-results` (`{LIC|PID|UNKNOWN}_<prenom>_<nom>_<uuid>.json`).
5. La page web de **JAE OCR** (`GET /` + polling `GET /api/participants`) affiche les fiches de participants (y compris les écrans Ten'Up incomplets) et coche automatiquement `id_checked` via un rapprochement Unicode tolérant (`nom`, `nom_usage`, prénoms multiples, inversions).

## Gestion des doublons & concurrence

- Chaque upload et chaque fichier résultat inclut un identifiant UUID court (`8` caractères hexadécimaux) afin d'éviter toute collision ou écrasement lors de scans rapprochés.
- Le verrou `.LOCK` est acquis de manière atomique côté GCS (`if_generation_match=0`), ce qui protège contre les doublons Eventarc et les accès concurrents multi-threads.
- La sécurité des endpoints d'upload peut être renforcée via la variable d'environnement optionnelle `SCANNER_API_KEY` (`X-API-Key` ou `Authorization: Bearer`).
