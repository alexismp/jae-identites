import os
import json
from flask import Flask, request, render_template
from google.cloud import storage
import google.generativeai as genai
from PIL import Image
import io
from datetime import datetime

def normalize_name(name):
    return name.replace(' ', '').replace('-', '').lower() if name else ''


# Initialiser Flask
app = Flask(__name__)

# Configurer l'API Gemini
try:
    # GOOGLE_API_KEY est normalement défini dans l'environnement Cloud Run
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        print("Avertissement : La variable d'environnement GOOGLE_API_KEY n'est pas définie.")
    genai.configure(api_key=api_key)
except Exception as e:
    print(f"Erreur lors de la configuration de l'API Gemini : {e}")

# Initialiser le client Google Cloud Storage
storage_client = storage.Client()

@app.route('/', methods=['POST'])
def index():
    # Les événements Cloud Storage sont envoyés en tant que requêtes POST
    envelope = request.get_json()
    if not envelope:
        msg = "no Pub/Sub message received"
        print(f"error: {msg}")
        return f"Bad Request: {msg}", 400

    try:
        bucket_name = envelope["bucket"]
        file_name = envelope["name"]
        
        # Vérifier l'existence d'un fichier .LOCK
        destination_bucket_name = "jae-scan-results"
        lock_filename = f"{file_name}.LOCK"
        destination_bucket = storage_client.bucket(destination_bucket_name)
        lock_blob = destination_bucket.blob(lock_filename)

        if lock_blob.exists():
            print(f"Lock file {lock_filename} exists. Skipping.")
            return "", 204

        handle_storage_event(bucket_name, file_name)

        return "", 204
    except Exception as e:
        print(f"Erreur lors du traitement du message : {e}")
        return "", 500

def handle_storage_event(bucket_name, file_name):
    print(f"Fichier {file_name} uploadé dans le bucket {bucket_name}.")
    
    destination_bucket_name = "jae-scan-results"
    lock_filename = f"{file_name}.LOCK"
    destination_bucket = storage_client.bucket(destination_bucket_name)
    lock_blob = destination_bucket.blob(lock_filename)

    try:
        # Créer le fichier .LOCK
        lock_blob.upload_from_string('')
        print(f"Created lock file: {lock_filename}")

        # Télécharger l'image depuis le bucket source
        source_bucket = storage_client.bucket(bucket_name)
        blob = source_bucket.blob(file_name)
        img_bytes = blob.download_as_bytes()
        img = Image.open(io.BytesIO(img_bytes))

        print(f"Image {file_name} téléchargée et prête pour l'analyse.")

        # Préparer le modèle et le prompt pour Gemini
        model = genai.GenerativeModel('gemini-2.5-flash')

        with open('prompt.txt', 'r') as f:
            prompt = f.read()

        prompt_parts = [
            img,
            prompt
        ]

        # Générer le contenu
        print("Sending request to Gemini API...")
        response = model.generate_content(prompt_parts, generation_config=genai.types.GenerationConfig(temperature=0.2))
        print("Received response from Gemini API.")

        # Extraire et nettoyer la réponse JSON
        response_text = response.text.strip()

        # S'assurer que la réponse est bien du JSON
        try:
            if response_text.startswith("```json"):
                response_text = response_text[7:]
            if response_text.endswith("```"):
                response_text = response_text[:-3]

            json_data = json.loads(response_text)
            
            # Extraire le prénom et le nom de famille pour le nom du fichier
            first_name = json_data.get("prenom", "unknown")
            last_name = json_data.get("nom", "unknown")
            doc_type = json_data.get("type", "unknown")
            # timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")

            # Construire le nom de fichier avec le préfixe approprié
            if doc_type.lower() == "licence":
                prefix = "LIC"
            elif doc_type.lower() == "identite":
                prefix = "PID"  # Pièce IDentité
            else:
                prefix = "UNKNOWN"
            
            # result_filename = f"{prefix}_{first_name}-{last_name}-{timestamp}.json"
            result_filename = f"{prefix}_{first_name}-{last_name}.json"

            # Uploader le résultat JSON dans le bucket de destination
            destination_bucket_name = "jae-scan-results"    # Need to make this a parameter
            destination_bucket = storage_client.bucket(destination_bucket_name)
            result_blob = destination_bucket.blob(result_filename)
            print(f"Uploading JSON file {result_filename} to bucket {destination_bucket_name}...")
            result_blob.upload_from_string(json.dumps(json_data, indent=4), content_type='application/json')
            print("JSON file uploaded successfully.")

            print(f"Résultat JSON sauvegardé sous {result_filename} dans {destination_bucket_name}")

        except json.JSONDecodeError:
            print(f"Erreur: La réponse de Gemini n'est pas un JSON valide. Réponse reçue:\n{response.text}")
        except Exception as e:
            print(f"Erreur lors de la sauvegarde du résultat JSON : {e}")

    except Exception as e:
        print(f"Erreur lors du traitement de l'image {file_name} : {e}")
    finally:
        # Supprimer le fichier .LOCK
        if lock_blob.exists():
            print(f"Deleting lock file: {lock_filename}")
            lock_blob.delete()

@app.route('/', methods=['GET'])
def serve_page():
    participants = {}
    bucket_name = "jae-scan-results"
    bucket = storage_client.bucket(bucket_name)
    blobs = bucket.list_blobs()

    for blob in blobs:
        if blob.name.startswith('LIC_') and blob.name.endswith('.json'):
            data = json.loads(blob.download_as_string())
            license_no = data.get("licence")
            if license_no:
                participants[license_no] = {
                    "nom": data.get("nom"),
                    "prenom": data.get("prenom"),
                    "licence": license_no,
                    "annee_validite": data.get("annee_validite"),
                    "classement": data.get("classement"),
                    "club": data.get("club"),
                    "statut": data.get("statut"),
                    "id_checked": False
                }

    blobs = bucket.list_blobs() # Re-list to iterate again
    for blob in blobs:
        if blob.name.startswith('PID_') and blob.name.endswith('.json'):
            # Assuming PID filename format is PID_PRENOM-NOM.json
            parts = blob.name.replace('PID_', '').replace('.json', '').split('-')
            if len(parts) == 2:
                prenom, nom = parts
                normalized_prenom = normalize_name(prenom)
                normalized_nom = normalize_name(nom)
                for lic, participant in participants.items():
                    if normalize_name(participant['prenom']) == normalized_prenom and normalize_name(participant['nom']) == normalized_nom:
                        participant['id_checked'] = True
                        break

    return render_template('index.html', participants=list(participants.values()))

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
