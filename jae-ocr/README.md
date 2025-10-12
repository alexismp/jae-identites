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

## Déploiement

Ce service est conçu pour être déployé en tant que service Cloud Run, déclenché par des événements Cloud Storage.

## Fonctionnement

1.  Un fichier image est téléchargé dans le bucket Cloud Storage d'entrée.
2.  L'événement de téléchargement déclenche le service JAE OCR.
3.  Le service télécharge l'image, l'envoie à l'API Gemini avec une invite pour extraire les informations.
4.  L'API Gemini retourne les données extraites au format JSON.
5.  Le service enregistre ces données JSON dans un bucket Cloud Storage de destination.