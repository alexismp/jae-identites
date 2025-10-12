# JAE OCR

JAE OCR est un service backend qui effectue la reconnaissance optique de caractères (OCR) sur des documents de type pièces d'identités ou licences FFT.

## Fonctionnalités

-   **Déclenchement automatique :** Le service est déclenché par le téléchargement d'une nouvelle image dans un bucket Google Cloud Storage.
-   **Extraction d'informations par IA :** Utilise l'API Google Gemini pour extraire le texte et les informations pertinentes de l'image du document.
-   **Stockage des résultats :** Enregistre les données extraites sous forme de fichier JSON structuré dans un bucket de résultats distinct.

## Technologies utilisées

-   **Python :** Le langage principal pour le service.
-   **Flask :** Un framework web léger pour gérer les événements.
-   **Google Generative AI :** Le service d'IA utilisé pour l'extraction d'informations.
-   **Google Cloud Storage :** Pour le stockage des images et des résultats.

## Déploiement sur Cloud Run

Après avoir construit l'image Docker localement, vous pouvez la déployer sur Cloud Run.

1.  **Construire l'image Docker :**
    ```bash
    docker build -t jae-ocr .
    ```

2.  **Tagger l'image pour Artifact Registry :**
    ```bash
    docker tag jae-ocr:latest europe-west1-docker.pkg.dev/alexismp-runner/jae-identites-repo/jae-ocr:latest
    ```

3.  **Pousser l'image vers Artifact Registry :**
    ```bash
    docker push europe-west1-docker.pkg.dev/alexismp-runner/jae-identites-repo/jae-ocr:latest
    ```

4.  **Déployer sur Cloud Run :**
    ```bash
    gcloud run deploy jae-ocr --image europe-west1-docker.pkg.dev/alexismp-runner/jae-identites-repo/jae-ocr:latest --region europe-west1
    ```

## Configuration du Déclencheur (Trigger)

Pour que le service `jae-ocr` soit automatiquement déclenché lors du téléversement d'un fichier dans le bucket `gs://jae-scan-bucket`, vous devez créer un déclencheur Eventarc.

1.  **Trouver le compte de service :**
    Vous aurez besoin de l'adresse e-mail du compte de service qui sera utilisé par le déclencheur. Vous pouvez utiliser le compte de service Compute Engine par défaut. Pour le trouver, exécutez la commande suivante en remplaçant `alexismp-runner` par votre ID de projet :
    ```bash
    gcloud projects describe alexismp-runner --format="value(projectNumber)"
    ```
    Le compte de service sera `[NUMERO_PROJET]-compute@developer.gserviceaccount.com`. Pour ce projet, c'est `2500276981-compute@developer.gserviceaccount.com`.

2.  **Créer le déclencheur :**
    Exécutez la commande suivante pour créer le déclencheur. Assurez-vous que le bucket se trouve dans la même région que le déclencheur (ici, `eu`).
    ```bash
    gcloud eventarc triggers create jae-ocr-trigger \
        --location=eu \
        --destination-run-service=jae-ocr \
        --destination-run-region=europe-west1 \
        --event-filters="type=google.cloud.storage.object.v1.finalized" \
        --event-filters="bucket=jae-scan-bucket" \
        --service-account="2500276981-compute@developer.gserviceaccount.com"
    ```

## Fonctionnement

1.  Un fichier image est téléchargé dans le bucket Cloud Storage d'entrée.
2.  L'événement de téléchargement déclenche le service JAE OCR.
3.  Le service télécharge l'image, l'envoie à l'API Gemini avec une invite pour extraire les informations.
4.  L'API Gemini retourne les données extraites au format JSON.
5.  Le service enregistre ces données JSON dans un bucket Cloud Storage de destination.