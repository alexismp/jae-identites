# JAE Ten'Up Roster Importer (Extension Chrome)

Extension Chrome permettant au Juge-Arbitre d'importer en un clic la composition complète des deux équipes depuis une page de rencontre Ten'Up vers le tableau de bord **JAE Identités**.

## Fonctionnalités (pour les utilisateurs)

- **Import en 1 clic depuis votre session Ten'Up** : ouvrez la page officielle de la rencontre sur `tenup.fft.fr` puis cliquez sur l'icône **JAE** et sur *« Extraire les 2 équipes vers JAE-OCR »*.
- **Aucune capture d'écran ni IA externe** : la lecture des deux équipes se fait directement dans votre navigateur, sans envoyer de page ni d'image à un LLM.
- **Ouverture automatique du tableau de bord** : dès que les deux équipes sont importées, un nouvel onglet s'ouvre automatiquement sur votre tableau **JAE-OCR** (avec les deux clubs déjà nommés et les joueurs prêts dans *Non-affecté*).
- **Connexion Juge-Arbitre Google OAuth intégrée** : connectez-vous une fois avec votre compte Google dans la popup ; l'extension réutilise directement l'identifiant officiel Ten'Up de l'URL (`/rencontre/<id>`) comme identifiant de rencontre dans **JAE-OCR** (`/m/<id>`), de façon idempotente en cas de réimport.
- **Interface propre à chaque utilisation** : le statut d'une exécution précédente est automatiquement effacé à la réouverture suivante de l'extension.

## Installation dans Chrome

1. Ouvrez `chrome://extensions/` dans Google Chrome.
2. Activez le **Mode développeur** (en haut à droite).
3. Cliquez sur **Charger l'extension non empaquetée** et sélectionnez le dossier `jae-identites/jae-tenup-extension`.

---

## Détails techniques

### Architecture Manifest V3 (`v1.3.2`)

- **Extraction pure DOM** (`background.js` + `parser.js`) :
  - Extrait l'identifiant officiel de rencontre depuis l'URL Ten'Up (`extractTenupMatchId`, ex. `/rencontre/<id>`) et le transmet en `tenupMatchId` pour le réutiliser directement comme identifiant Firestore `/m/<id>`.
  - Cible la carte de rencontre Ten'Up dans le DOM (en excluant `header`, `nav`, `footer` et les liens parasites) pour extraire les URLs des deux équipes.
  - Ouvre brièvement chaque page d'équipe dans un onglet actif (`active: true`, nécessaire pour l'hydratation Next.js / `requestAnimationFrame` de Ten'Up), extrait les cartes `[data-slot="card"]` de la section `L'équipe` via `.textContent`, puis referme les onglets temporaires.
  - Envoie le JSON structuré (`team1Name`, `team1Players`, `team2Name`, `team2Players`, `tenupUrl`, `tenupMatchId`) à `POST /api/tenup/roster` sur `jae-ocr` (sans LLM).
- **Popup & icônes** (`popup.html`, `popup.js`, `icons/`) :
  - URL du service `jae-ocr` configurable, bouton d'accès direct et ouverture d'onglet via `chrome.tabs.create`.
  - Icônes plein cadre `icon16.png`, `icon48.png`, `icon128.png` et logo `logo.svg`.

### Tests unitaires

```bash
node --test jae-tenup-extension/parser.test.js
```
