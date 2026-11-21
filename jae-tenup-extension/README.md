# JAE Ten'Up Roster Importer (Extension Chrome MV3)

Extension Chrome Manifest V3 qui automatise en 1 clic la récupération des compositions des deux équipes depuis une page de rencontre Ten'Up (en utilisant ta session Chrome déjà connectée) et les envoie vers `jae-ocr`.

## Installation dans Chrome (30 secondes)

1. Ouvre `chrome://extensions/` dans Google Chrome.
2. Active le **Mode développeur** (en haut à droite).
3. Clique sur **Charger l'extension non empaquetée** et sélectionne le dossier `jae-identites/jae-tenup-extension`.

## Utilisation

1. Ouvre ta rencontre sur `tenup.fft.fr` (en étant connecté).
2. Clique sur l'icône de l'extension **JAE Ten'Up** → **« Extraire les 2 équipes vers JAE-OCR »**.
3. L'extension ouvre automatiquement les fiches des 2 équipes en arrière-plan, lit la liste des joueurs, puis envoie le tout à `jae-ocr` (`POST /api/tenup/extract-roster`), qui extrait les noms/prénoms via Vertex AI (`gemini-4-hydrogen`) et les affiche dans l'interface JAE-OCR.
