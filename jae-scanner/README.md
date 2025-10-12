# JAE Scanner

JAE Scanner est une application web qui numérise des documents (pièces d'identités ou licences) à l'aide de l'appareil photo d'un appareil et les télécharge pour traitement.

## Fonctionnalités

-   **Numérisation par appareil photo :** Utilise l'appareil photo de l'appareil pour capturer une image du document.
-   **Téléchargement d'images :** Télécharge l'image capturée dans un bucket Google Cloud Storage.

## Technologies utilisées

### Backend

-   **Python :** Le langage principal pour le backend.
-   **Flask :** Un framework web léger pour Python.
-   **Gunicorn :** Un serveur HTTP WSGI Python pour UNIX.

### Frontend

-   **HTML/CSS/JavaScript :** Le trio standard pour le développement web.

### Conteneurisation

-   **Docker :** L'application est conteneurisée pour un déploiement facile.

## Démarrage

### Prérequis

-   Docker

### Installation

1.  **Cloner le dépôt :**
    ```bash
    git clone https://github.com/your-username/jae-identites.git
    cd jae-identites/jae-scanner
    ```
2.  **Construire et lancer le conteneur Docker :**
    ```bash
    docker build -t jae-scanner .
    docker run -p 8080:8080 jae-scanner
    ```
3.  **Accéder à l'application :**
    -   Ouvrez votre navigateur web et accédez à `http://localhost:8080`.

## Fonctionnement

1.  L'utilisateur pointe l'appareil photo de son appareil vers un document.
2.  Une fois qu'une image nette est détectée, elle est capturée et envoyée au backend Flask.
3.  Le backend reçoit l'image et la télécharge dans un bucket Google Cloud Storage.
4.  Le backend retourne une confirmation avec le nom du fichier téléchargé.