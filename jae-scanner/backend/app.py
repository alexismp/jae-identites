import os
from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
from PIL import Image
import io
from datetime import datetime
from google.cloud import storage
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)

# Récupérer la version de l'application depuis les variables d'environnement
APP_VERSION = os.getenv('APP_VERSION', 'development')

# Initialiser Flask pour servir les fichiers statiques depuis le dossier 'static'
# et les templates depuis le dossier 'templates'
app = Flask(__name__, static_folder='static', template_folder='templates')
CORS(app)

@app.route('/')
def index():
    return render_template('index.html', app_version=APP_VERSION)

@app.route('/scan', methods=['POST'])
def scan_image():
    if 'file' not in request.files:
        return jsonify({"error": "Aucun fichier n'a été envoyé"}), 400

    file = request.files['file']

    if file.filename == '':
        return jsonify({"error": "Aucun fichier n'a été sélectionné"}), 400

    if file:
        try:
            # Lire l'image en mémoire
            img_bytes = file.read()
            logging.info(f"Taille du fichier '{file.filename}' reçu : {len(img_bytes)} bytes")
            img = Image.open(io.BytesIO(img_bytes))

            # Uploader l'image sur Google Cloud Storage
            try:
                storage_client = storage.Client()
                bucket_name = "jae-scan-bucket"
                bucket = storage_client.bucket(bucket_name)
                
                # Créer un nom de fichier unique avec un timestamp
                timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
                unique_filename = f"{timestamp}-{file.filename}"
                blob = bucket.blob(unique_filename)
                
                # Uploader les bytes de l'image
                blob.upload_from_string(img_bytes, content_type=file.content_type)
                logging.info(f"Image {unique_filename} uploaded to {bucket_name}.")
                
                logging.info(f"Image reçue: {file.filename}, format: {img.format}, taille: {img.size}")

                return jsonify({"uploaded_file": unique_filename})

            except Exception as e:
                logging.error(f"Erreur lors de l'upload sur Google Cloud Storage : {e}")
                return jsonify({"error": f"Erreur lors de l'upload sur Google Cloud Storage: {str(e)}"}), 500

        except Exception as e:
            logging.error(f"Erreur lors de la manipulation de l'image : {e}")
            return jsonify({"error": f"Erreur lors de la manipulation de l'image: {str(e)}"}), 500

    return jsonify({"error": "Une erreur inattendue est survenue"}), 500


if __name__ == '__main__':
    # Le port 5001 est utilisé pour éviter les conflits avec d'autres services
    app.run(debug=True, port=5001)