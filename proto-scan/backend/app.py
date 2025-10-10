import os
from flask import Flask, request, jsonify, render_template, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
import google.generativeai as genai
from PIL import Image
import io

# Charger les variables d'environnement (pour la clé API)
load_dotenv()

# Initialiser Flask pour servir les fichiers statiques depuis le dossier 'static'
# et les templates depuis le dossier 'templates'
app = Flask(__name__, static_folder='../static', template_folder='templates')
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
    return render_template('index.html')

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
            img = Image.open(io.BytesIO(img_bytes))

            # À ce stade, l'image est prête à être envoyée à Gemini.
            # Pour l'instant, nous confirmons simplement la réception.
            print(f"Image reçue: {file.filename}, format: {img.format}, taille: {img.size}")

            # Préparer le modèle et le prompt pour Gemini
            model = genai.GenerativeModel('gemini-2.5-flash')

            prompt_parts = [
                img,
                "\nAnalyse l'image de cette attestation de licence de la Fédération Française de Tennis (FFT) et extrais les informations suivantes au format JSON strict :",
                "1. `nom`: Le nom de famille de la personne (en majuscules).",
                "2. `prenom`: Le prénom de la personne.",
                "3. `licence`: Le numéro de licence. Il se trouve généralement sur la deuxième ligne et est composé de chiffres et/ou d'une lettre.",
                "4. `annee_validite`: L'année de validité de la licence. C'est un nombre de 4 chiffres bien visible.",
                "5. `classement`: Le classement tennis. Il se trouve à droite de la mention 'Classement tennis'. Les valeurs possibles sont NC, 40, 30/5, 30/4, 30/3, 30/2, 30/1, 30, 15/5, 15/4, 15/3, 15/2, 15/1, 15, 5/6, 4/6, 3/6, 2/6, 1/6, 0, -2/6, -4/6, -15, ou un nombre. Ne retourne que la valeur du classement.",
                "\nExemple de réponse attendue : {\"nom\": \"MARTIN\", \"prenom\": \"Léa\", \"licence\": \"1234567B\", \"annee_validite\": \"2025\", \"classement\": \"30/1\"}",
                "\nNe retourne que le JSON, sans aucun texte ou formatage supplémentaire comme les backticks '```json'."
            ]

            # Générer le contenu
            response = model.generate_content(prompt_parts)

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