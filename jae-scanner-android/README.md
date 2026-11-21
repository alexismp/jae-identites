# JAE Scanner Android

Application Android native (Kotlin + Jetpack Compose + CameraX) destinée à remplacer l'application web `jae-scanner` pour la capture de pièces d'identité (CNI française ancien/nouveau format, passeports français et étrangers) et de licences FFT (attestations et écrans Ten'Up).

## Fonctionnalités implémentées (`v0.2.0`)

- **Double mode de cadrage** (`ui/ScannerScreen.kt`) :
  - **Identité** : cadre paysage **ID-1 (`1.586`)** + repère pointillé **ID-2 / biopage passeport (`1.42`)**, contrôle **Torche / Flash auto / Off**, tap-to-focus (`FocusMeteringAction`).
  - **Licence / Ten'Up** : cadre **portrait**, coupure automatique du flash/torche et légère sous-exposition (`EV -2`) pour éviter les reflets et écrans cramés.
- **Analyse qualité temps réel on-device** (`quality/ImageQualityAnalyzer.kt`) : détection locale du flou (Laplacien), des reflets et du contraste sur le canal luminance YUV, avec seuils adaptés au mode (pas de faux positifs sur fond blanc Ten'Up).
- **Validation post-capture on-device** (`quality/MrzParser.kt`, `quality/PostCaptureValidator.kt`) :
  - **Parser MRZ ICAO 9303** pur Kotlin (**TD1** CNIe verso, **TD2** CNI ancienne, **TD3** passeports FR & étrangers) avec vérification des **check digits** (modulo 10, poids 7-3-1) via ML Kit Text Recognition.
  - **Détection licence FFT** (`\d{7}[A-Z]` + mots-clés FFT/Ten'Up) pour alerter immédiatement si le joueur n'est pas sur le bon onglet.
  - Point d'extension `GeminiNanoPostCaptureValidator` prêt pour **Gemini Nano (Android AICore / ML Kit GenAI)**.
- **Upload résilient** (`network/ScanUploader.kt`) :
  - Priorité à l'**upload direct GCS** via `POST /api/upload-url` sur `jae-ocr` (Signed URL v4) avec support `X-API-Key`.
  - **Fallback automatique** vers `POST /scan` sur `jae-scanner`.
- **Tests unitaires** (`app/src/test/java/com/jae/scanner/quality/MrzParserTest.kt`) : couverture TD1, TD2, TD3 et détection licence Ten'Up.

## Ouvrir et lancer dans Android Studio

Ce module fait partie intégrante du dépôt `jae-identites` (au même titre que `jae-scanner` et `jae-ocr`).

1. Dans **Android Studio**, ouvre directement le sous-répertoire `jae-identites/jae-scanner-android` (File → Open).
2. Laisse Gradle synchroniser les dépendances (le wrapper Gradle peut être généré via Android Studio ou `gradle wrapper`).
3. Lance l'application sur un appareil Android physique (API 26+) pour tester la torche, le flash, le double mode Identité / Ten'Up et le parser MRZ.

## Configuration (`local.properties`)

Les URLs Cloud Run de production sont préconfigurées par défaut dans `app/build.gradle.kts`. Pour les surcharger ou activer une clé API partagée :

```properties
ocr.backend.url=https://jae-ocr-2500276981.europe-west1.run.app
scanner.backend.url=https://jae-scanner-2500276981.europe-west1.run.app
scanner.api.key=
```
