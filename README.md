**Note importante :** Ce projet est un développement personnel et n'est en aucun cas affilié à la Fédération Française de Tennis (FFT). L'objectif de cet outil est uniquement de proposer une solution pour la phase de vérification des identités lors des rencontres par équipe.

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

#### Page de gestion de la rencontre

Le module `jae-ocr` inclut désormais une page web accessible à la racine du service pour gérer la rencontre. Cette page offre les fonctionnalités suivantes :

-   **Titre de la rencontre modifiable** : Le titre de la page est "Rencontre du [Date du jour]" par défaut et peut être modifié.
-   **Sections pour les officiels et les équipes** : La page est divisée en sections pour les officiels, deux équipes et une section pour les fiches non-affectées.
-   **Gestion des fiches de participants** :
    -   Les fiches des participants sont créées à partir des fichiers `LIC_*.json` trouvés dans le bucket `jae-scan-results`.
    -   Les fiches peuvent être déplacées par glisser-déposer entre les différentes sections.
    -   Le nom des équipes est automatiquement mis à jour avec le nom du club du premier participant ajouté à l'équipe.
-   **Vérification des pièces d'identité** : Une case à cocher sur chaque fiche indique si la pièce d'identité a été présentée. Cette case est automatiquement cochée si un fichier `PID_*.json` correspondant est trouvé.

## Flux de travail

1.  L'utilisateur accède à l'interface web du **JAE Scanner** et numérise un document.
2.  L'image capturée est téléchargée dans un bucket Cloud Storage.
3.  Le téléchargement déclenche le service **JAE OCR**.
4.  **JAE OCR** traite l'image avec Gemini, extrait les données et enregistre le JSON résultant dans un autre bucket Cloud Storage.