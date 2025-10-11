# Utiliser une image Python officielle comme image de base
FROM python:3.10-slim

# Définir le répertoire de travail dans le conteneur
WORKDIR /app

# Copier les fichiers de dépendances du backend
COPY proto-scan-trigger/backend/requirements.txt requirements.txt

# Installer les dépendances
RUN pip install --no-cache-dir -r requirements.txt

# Copier tous les fichiers du projet (frontend et backend)
# Le backend est à la racine, le frontend dans /app/static
COPY proto-scan-trigger/backend/ /app/
COPY proto-scan-trigger/static/ /app/static/


# Rendre le port 8080 disponible pour le monde extérieur
EXPOSE 8080

# Définir la variable d'environnement pour le port
ENV PORT=8080

# Commande pour lancer l'application avec Gunicorn
# Le nombre de workers est une recommandation générale.
CMD exec gunicorn --enable-stdio-inheritance --bind :$PORT --workers 1 --threads 8 --timeout 0 app:app