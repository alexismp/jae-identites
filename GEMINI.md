# Configuration de l'environnement

Ce document récapitule les configurations et les informations spécifiques à l'environnement utilisées lors des sessions avec l'agent Gemini, afin d'éviter de répéter les étapes et de faciliter les futures interactions.

## Informations Générales

-   **Système d'exploitation :** macOS (ARM64)
-   **Client Git :** Authentification via SSH avec GitHub.

## Outils de Conteneurisation

-   **Moteur de conteneur :** Podman (installé via Homebrew).
    -   **Alias :** `docker` est aliasé à `podman` dans `~/.zprofile`.
    -   **Note :** Lors de l'exécution de commandes `podman` via l'agent, il est nécessaire de spécifier explicitement le `PATH` pour inclure `/opt/homebrew/bin` et `~/google-cloud-sdk/bin` en raison de l'isolation de l'environnement d'exécution de l'agent.
    -   **Exemple de PATH :** `export PATH="/opt/homebrew/bin:~/google-cloud-sdk/bin:$PATH"`

## Google Cloud Platform (GCP)

-   **CLI :** Google Cloud SDK (`gcloud`) est installé.
    -   **Note :** Lors de l'exécution de commandes `gcloud` via l'agent, il est nécessaire de spécifier explicitement le chemin complet de l'exécutable (`~/google-cloud-sdk/bin/gcloud`) et d'inclure `~/google-cloud-sdk/bin` dans le `PATH`.
-   **Projet ID :** `alexismp-runner`
-   **Région Cloud Run :** `europe-west1`
-   **Type de registre :** Artifact Registry (et non Container Registry)
-   **Nom du dépôt Artifact Registry :** `jae-identites`
-   **Clé API Google :** `GOOGLE_API_KEY` est fournie en tant que variable d'environnement lors du déploiement Cloud Run. La valeur de cette variable doit être récupérée depuis le fichier `.env`.

## Déploiement Cloud Run (Module `jae-ocr`)

-   **Image Docker :** `jae-ocr:latest`
-   **Architecture de build :** Les images pour Cloud Run doivent être construites pour la plateforme `linux/amd64` en utilisant `--platform linux/amd64` avec `podman build`.
-   **Commande de déploiement :**
    ```bash
    export PATH="/opt/homebrew/bin:~/google-cloud-sdk/bin:$PATH" && \
    ~/google-cloud-sdk/bin/gcloud run deploy jae-ocr \
      --image europe-west1-docker.pkg.dev/alexismp-runner/jae-identites/jae-ocr:latest \
      --region europe-west1 \
      --project alexismp-runner \
      --set-env-vars GOOGLE_API_KEY=[VALEUR_DE_GOOGLE_API_KEY] \
      --allow-unauthenticated \
      --timeout 600
    ```