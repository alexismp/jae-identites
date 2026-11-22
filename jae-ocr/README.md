# JAE OCR (Tableau de bord & serveur de reconnaissance)

Tableau de bord web de gestion de la rencontre par équipes et service backend recevant les validations d'identité (locales ou de secours).

## Fonctionnalités (pour les utilisateurs)

- **Tableau de rencontre clair en 4 zones** : **Officiels**, **Équipe 1**, **Équipe 2** et **Non-affecté**, avec vue complète ou condensée.
- **Validation et placement automatiques** : les joueurs importés de Ten'Up attendent dans *Non-affecté* ; dès que leur pièce d'identité (CNI ou passeport) est scannée, la case *Pièce d'identité* se coche et leur fiche bascule automatiquement dans la colonne de leur équipe.
- **Protection contre les erreurs** : les noms de clubs importés de Ten'Up sont verrouillés (ils ne sont plus écrasés par un glisser-déposer) et il est impossible de déposer une joueuse ou un joueur dans la colonne de l'équipe adverse.
- **Contrôle réglementaire strict** : seuls les **CNI et passeports** sont acceptés (permis de conduire et titres de séjour refusés) ; une pièce d'identité seule sans licence ni présence dans la liste Ten'Up (ex. officiel) attend sa licence avant de créer une fiche.
- **Synchronisation multi-écrans** : chaque glisser-déposer, titre ou lien Ten'Up est partagé automatiquement entre tous les ordinateurs/tablettes connectés.
- **Accès sécurisé & multi-rencontres en parallèle** : authentification nominative (Firebase Auth) avec validation préalable par l'administrateur, **une seule rencontre active par JAE à la fois**, et URL dédiée `/m/<matchId>` qui survit au rafraîchissement de la page.
- **Console d'administration séparée (`/admin`)** : URL dédiée (hors interface de rencontre) permettant à l'administrateur (`alexis.mp@gmail.com` par défaut, extensible dynamiquement dans Firestore) d'approuver/bloquer les utilisateurs, promouvoir d'autres administrateurs, consulter/archiver/nettoyer toutes les rencontres et analyser l'historique d'activité et les erreurs.
- **Gestion de rencontre** : lien cliquable vers la feuille Ten'Up, **Exporter / Importer une rencontre** (JSON), **Nouvelle rencontre** (archivage automatique dans Firestore) et **Mode Debug** (`?debug=true`) isolé pour les essais.

---

## Détails techniques

### Modèle Cloud Firestore (`backend/match_store.py`)

- `users/{uid}` : `email`, `role` (`"admin"` | `"user"`), `approved` (`bool`), `activeMatchId` (unicité de rencontre active par JAE).
- `approved_emails/{email}` : pré-autorisation d'adresses avant inscription.
- `matches/{matchId}` : `ownerUid`, `ownerEmail`, `status` (`"active"` | `"archived"`), `team1Name`, `team2Name`, `tenupUrl`, `roster`, `boardState` + sous-collections `licences`, `identities`, `scan_status`.
- `activity_logs/{docId}` : journal historique horodaté (inscriptions, validations MRZ, imports Ten'Up, OCR Gemini, modifications tableau, actions admin, erreurs).

### Endpoints principaux (`backend/app.py`)

- `GET /` & `GET /m/<matchId>` : tableau web authentifié (redirection vers `/m/<activeMatchId>`).
- `GET /api/me` & `POST /api/matches/new` : profil utilisateur, rencontre active unique et création/archivage de rencontre.
- `GET /api/matches/<matchId>/participants`, `GET/POST /api/matches/<matchId>/roster`, `GET/POST /api/matches/<matchId>/board-state` : données et synchronisation multi-machines isolées par rencontre.
- `GET /admin`, `GET /api/admin/overview`, `POST /api/admin/users/<uid>`, `POST /api/admin/preapprove`, `POST /api/admin/matches/<matchId>/archive`, `DELETE /api/admin/matches/<matchId>`, `POST /api/admin/cleanup-archived` : console d'administration dédiée.
- `POST /api/identite/direct` : **circuit court sans LLM ni photo** (Android MRZ valide) rattaché automatiquement à `activeMatchId` de l'utilisateur connecté.
- `POST /api/upload-url` & `POST /` (Eventarc) : **fallback OCR serveur** avec préfixe GCS `m_<matchId>/...` pour router les résultats Gemini (`gemini-4-hydrogen` sur Vertex AI) vers la bonne rencontre Firestore.

### Variables d'environnement

| Variable | Défaut | Description |
| :--- | :--- | :--- |
| `GCP_PROJECT` | `alexismp-runner` | Projet GCP pour Vertex AI (`google-genai`, auth par compte de service IAM) |
| `VERTEX_LOCATION` | `global` | Région Vertex AI pour `gemini-4-hydrogen` |
| `GEMINI_MODEL` | `gemini-4-hydrogen` | Modèle Gemini utilisé en fallback OCR |
| `SCAN_BUCKET_NAME` | `jae-scan-bucket` | Bucket GCS des photos de secours |
| `RESULTS_BUCKET_NAME` | `jae-scan-results` | Bucket GCS des JSON, rosters, état du tableau et archives |
| `SCANNER_API_KEY` | *(optionnel)* | Clé API partagée (`X-API-Key` / `Bearer`) pour les endpoints d'écriture |

### Déploiement sur Cloud Run & rôles IAM

```bash
podman build --platform linux/amd64 \
  -t europe-west1-docker.pkg.dev/alexismp-runner/jae-identites/jae-ocr:latest \
  ./jae-ocr

podman push europe-west1-docker.pkg.dev/alexismp-runner/jae-identites/jae-ocr:latest

gcloud run deploy jae-ocr \
  --project alexismp-runner \
  --image europe-west1-docker.pkg.dev/alexismp-runner/jae-identites/jae-ocr:latest \
  --region europe-west1 \
  --allow-unauthenticated \
  --set-env-vars="GCP_PROJECT=alexismp-runner,VERTEX_LOCATION=global"
```

Rôles IAM requis sur le compte de service Cloud Run : `roles/aiplatform.user`, `roles/storage.objectAdmin`, `roles/iam.serviceAccountTokenCreator`.
