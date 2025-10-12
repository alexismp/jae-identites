import os
from flask import Flask, request, jsonify, render_template, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
import google.generativeai as genai
from PIL import Image
import io
from datetime import datetime
from google.cloud import storage

# Charger les variables d'environnement (pour la clé API)
load_dotenv()

# Récupérer la version de l'application depuis les variables d'environnement
APP_VERSION = os.getenv('APP_VERSION', 'development')

# Initialiser Flask pour servir les fichiers statiques depuis le dossier 'static'
# et les templates depuis le dossier 'templates'
app = Flask(__name__, static_folder='static', template_folder='templates')
CORS(app)

# Configurer l'API Gemini
# La clé est chargée depuis le fichier .env
# Assurez-vous de créer un fichier .env à la racine de /backend avec :
# GOOGLE_API_KEY="VOTRE_CLE_API_ICI"
try:
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        print("Avertissement : La variable d'environnement GOOGLE_API_KEY n'est pas définie.")
    genai.configure(api_key=api_key)
except Exception as e:
    print(f"Erreur lors de la configuration de l'API Gemini : {e}")


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
            print(f"Taille du fichier '''{file.filename}''' reçu : {len(img_bytes)} bytes")
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
                print(f"Image {unique_filename} uploaded to {bucket_name}.")
                print(f"Image {unique_filename} uploadée avec succès sur {bucket_name}")

            except Exception as e:
                print(f"Erreur lors de l'upload sur Google Cloud Storage : {e}")
                # On ne bloque pas le flux principal si l'upload échoue, 
                # mais on log l'erreur pour le débogage.

            # À ce stade, l'image est prête à être envoyée à Gemini.
            # Pour l'instant, nous confirmons simplement la réception.
            print(f"Image reçue: {file.filename}, format: {img.format}, taille: {img.size}")

            # Préparer le modèle et le prompt pour Gemini
            model = genai.GenerativeModel('gemini-2.5-flash')

            with open('prompt.txt', 'r') as f:
                prompt = f.read()

            prompt_parts = [
                img,
                prompt
            ]

            # Générer le contenu
            response = model.generate_content(prompt_parts, generation_config=genai.types.GenerationConfig(temperature=0.2))

            # Extraire et nettoyer la réponse JSON
            response_text = response.text.strip()

            # S'assurer que la réponse est bien du JSON
            try:
                # On retire les potentiels démarqueurs de code block
                if response_text.startswith("```json"):
                    response_text = response_text[7:]
                if response_text.endswith("```"):
                    response_text = response_text[:-3]

                import json
                json_data = json.loads(response_text)
                return jsonify(json_data)
            except json.JSONDecodeError:
                print(f"Erreur: La réponse de Gemini n'est pas un JSON valide. Réponse reçue:\n{response.text}")
                return jsonify({"error": "Erreur lors de l'analyse de la réponse du modèle IA.", "raw_response": response.text}), 500

        except Exception as e:
            print(f"Erreur lors de l'appel à l'API Gemini : {e}")
            return jsonify({"error": f"Erreur lors de la communication avec le service d'IA: {str(e)}"}), 500

    return jsonify({"error": "Une erreur inattendue est survenue"}), 500


if __name__ == '__main__':
    # Le port 5001 est utilisé pour éviter les conflits avec d'autres services
    app.run(debug=True, port=5001)