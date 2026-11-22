# JAE Scanner Android

Application mobile Android dédiée au contrôle rapide des pièces d'identité et des licences FFT au bord du court.

## Fonctionnalités (pour les utilisateurs)

- **Scan instantané sans envoi de photo** : pour les cartes d'identité (ancien ou nouveau format verso) et les passeports lisibles localement, la vérification se fait directement sur le téléphone en **moins d'une seconde** — aucune photo n'est envoyée sur le serveur.
- **Aucune sélection manuelle de mode** : l'application reconnaît automatiquement s'il s'agit d'une pièce d'identité ou d'une attestation de licence FFT / écran Ten'Up.
- **Refus immédiat des pièces non autorisées** : seuls les **CNI et passeports** sont acceptés ; les permis de conduire et titres/cartes de séjour sont rejetés immédiatement à l'écran.
- **Enchaînement rapide des scans** : la prise de vue libère immédiatement le bouton pour scanner plusieurs joueurs à la suite sans attendre le réseau.
- **Aide au cadrage et à l'éclairage** : cadre visuel qui passe au vert quand l'image est nette, contrôle **Torche / Flash auto / Off** et mise au point tactile.
- **Connexion Juge-Arbitre OAuth (sans mot de passe)** : connexion en 1 clic via OAuth (Google, Microsoft ou Apple via `/mobile-auth` → deep link `jaescanner://auth`) associant automatiquement chaque scan à votre **rencontre active unique**.
- **Historique des actions** : un appui sur le logo **JAE** en haut à gauche affiche votre compte connecté (avec déconnexion) et le journal horodaté des dernières validations, envois et refus.
- **Analyse de secours automatique** : si la bande MRZ est absente ou illisible (ex. recto seul de nouvelle CNIe, licence FFT), l'application compresse automatiquement la photo et l'envoie au serveur pour reconnaissance.

---

## Détails techniques

### Pipeline de traitement on-device (`Kotlin`, `Jetpack Compose`, `CameraX`, `ML Kit`)

1. **Qualité temps réel** (`quality/ImageQualityAnalyzer.kt`) : détection locale du flou (Laplacien), des reflets et du contraste sur la luminance YUV.
2. **Rejet local & classification** (`quality/PostCaptureValidator.kt`) :
   - Rejet immédiat sur mots-clés de permis de conduire / titre ou carte de séjour.
   - Parser **MRZ ICAO 9303** pur Kotlin (`quality/MrzParser.kt` : **TD1** CNIe verso, **TD2** CNI ancienne, **TD3** passeports FR & étrangers) avec vérification des clés de contrôle (modulo 10, poids 7-3-1).
3. **Circuit court sans LLM** (`network/ScanUploader.kt`) :
   - Si MRZ valide (`checkDigitsValid == true` + nom/prénom non vides) → `POST /api/identite/direct` (~200 octets JSON, zéro image, zéro appel LLM).
4. **Fallback photo compressée + OCR serveur** :
   - Redimensionnement local **1600 px max**, qualité JPEG 82 (~250 Ko).
   - Upload prioritaire via **GCS Signed URL v4** (`POST /api/upload-url` sur `jae-ocr`), fallback `POST /scan` sur `jae-scanner`, timeouts `write`/`read` 60 s.
   - Suivi asynchrone jusqu'à 80 s (`GET /api/scan-status/<fichier>`) avec alerte explicite en cas d'erreur ou de dépassement de délai.
5. **Icône adaptative** : `res/mipmap-anydpi-v26/ic_launcher.xml` (`ic_launcher_background.xml` + `ic_launcher_foreground.xml`).

### Compiler, tester et installer (CLI, sans Android Studio)

```bash
cd jae-scanner-android
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./gradlew testDebugUnitTest assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Tests unitaires (`app/src/test/java/com/jae/scanner/quality/MrzParserTest.kt`) : TD1, TD2, TD3, détection licence FFT/Ten'Up et rejet permis de conduire / titre de séjour.

### Configuration (`local.properties`)

Les URLs Cloud Run de production sont préconfigurées dans `app/build.gradle.kts`. Surcharge optionnelle :

```properties
ocr.backend.url=https://jae-ocr-2500276981.europe-west1.run.app
scanner.backend.url=https://jae-scanner-2500276981.europe-west1.run.app
scanner.api.key=
```
