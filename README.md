# JAE Identités

JAE Scan est une application web qui fonctionne sur téléphone portable pour permettre aux Juges-Arbitres par Équipe (JAE) de vérifier les identités et les licences des joueurs qui participent à une rencontre par équipe.

Ce projet contient deux modules principaux pour la numérisation et le traitement de documents d'identité et de licences.

## Modules

### 1. JAE Scanner (`jae-scanner`)

Ce module est une interface web front-end conçue pour capturer des images de documents à l'aide de l'appareil photo d'un appareil.

-   **Fonctionnalité** : Fournit une interface utilisateur dans le navigateur pour numériser des documents (pièces d'identités ou licences)
-   **Technologie** : Développé avec Python, Flask et des technologies front-end standard (HTML, CSS, JavaScript).
-   **Sortie** : Télécharge l'image capturée dans un bucket Google Cloud Storage pour traitement.

### 2. JAE OCR (`jae-ocr`)

Ce module est un service backend qui effectue la reconnaissance optique de caractères (OCR) sur les documents téléchargés par le JAE Scanner.

-   **Fonctionnalité** :
    -   Déclenché par le téléchargement de nouvelles images dans un bucket Google Cloud Storage spécifique.
    -   Utilise l'API Google Gemini pour extraire le texte et les informations pertinentes de l'image du document.
    -   Enregistre les données extraites sous forme de fichier JSON structuré dans un bucket de résultats distinct.
-   **Technologie** : Un service basé sur Python qui s'appuie sur l'IA de Google Gemini.

## Flux de travail

1.  L'utilisateur accède à l'interface web du **JAE Scanner** et numérise un document.
2.  L'image capturée est téléchargée dans un bucket Cloud Storage.
3.  Le téléchargement déclenche le service **JAE OCR**.
4.  **JAE OCR** traite l'image avec Gemini, extrait les données et enregistre le JSON résultant dans un autre bucket Cloud Storage.