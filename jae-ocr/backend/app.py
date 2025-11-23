import os
import json
from flask import Flask, request, render_template, jsonify
from google.cloud import storage
import google.generativeai as genai
from PIL import Image, ImageFilter, ImageStat
import io
from datetime import datetime
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)


def normalize_name(name):
    return name.replace(' ', '').replace('-', '').lower() if name else ''


def crop_center(image, crop_percent=0.5):
    width, height = image.size
    new_width = width * crop_percent
    new_height = height * crop_percent
    left = (width - new_width) / 2
    top = (height - new_height) / 2
    right = (width + new_width) / 2
    bottom = (height + new_height) / 2
    return image.crop((left, top, right, bottom))

def detect_blur(image, threshold=100):
    try:
        # Crop to center to avoid background noise
        image = crop_center(image)
        gray_image = image.convert('L')
        edges = gray_image.filter(ImageFilter.FIND_EDGES)
        stat = ImageStat.Stat(edges)
        variance = stat.var[0]
        return variance < threshold
    except Exception as e:
        logging.error(f"Error in detect_blur: {e}")
        return False

def detect_glare(image, threshold=250, pixel_percent=0.05):
    try:
        gray_image = image.convert('L')
        hist = gray_image.histogram()
        bright_pixels = sum(hist[threshold:])
        total_pixels = image.width * image.height
        ratio = bright_pixels / total_pixels
        return ratio > pixel_percent
    except Exception as e:
        logging.error(f"Error in detect_glare: {e}")
        return False

def detect_low_contrast(image, threshold=50):
    try:
        gray_image = image.convert('L')
        extrema = gray_image.getextrema()
        if extrema:
            min_val, max_val = extrema
            contrast_range = max_val - min_val
            return contrast_range < threshold
        return False
    except Exception as e:
        logging.error(f"Error in detect_low_contrast: {e}")
        return False


# Initialiser Flask
app = Flask(__name__)

# Configurer l'API Gemini
try:
    # GOOGLE_API_KEY est normalement défini dans l'environnement Cloud Run
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        logging.warning("Avertissement : La variable d'environnement GOOGLE_API_KEY n'est pas définie.")
    genai.configure(api_key=api_key)
except Exception as e:
    logging.error(f"Erreur lors de la configuration de l'API Gemini : {e}")

# Initialiser le client Google Cloud Storage
storage_client = storage.Client()

@app.route('/', methods=['POST'])
def index():
    # Les événements Cloud Storage sont envoyés en tant que requêtes POST
    envelope = request.get_json()
    if not envelope:
        msg = "no Pub/Sub message received"
        logging.error(f"error: {msg}")
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
            logging.info(f"Lock file {lock_filename} exists. Skipping.")
            return "", 204

        handle_storage_event(envelope)

        return "", 204
    except Exception as e:
        logging.error(f"Erreur lors du traitement du message : {e}")
        return "", 500

def handle_storage_event(event):
    """Traite un événement de stockage Cloud Storage."""
    file_data = event
    bucket_name = file_data['bucket']
    file_name = file_data['name']

    logging.info(f"Processing file: {file_name} from bucket: {bucket_name}")

    # Vérifier si le fichier est une image
    if not file_name.lower().endswith(('.png', '.jpg', '.jpeg')):
        logging.info(f"File {file_name} is not an image. Skipping.")
        return
    
    destination_bucket_name = "jae-scan-results"
    lock_filename = f"{file_name}.LOCK"
    destination_bucket = storage_client.bucket(destination_bucket_name)
    lock_blob = destination_bucket.blob(lock_filename)

    try:
        # Créer le fichier .LOCK
        lock_blob.upload_from_string('')
        logging.info(f"Created lock file: {lock_filename}")

        # Télécharger l'image depuis le bucket source
        source_bucket = storage_client.bucket(bucket_name)
        blob = source_bucket.blob(file_name)
        img_bytes = blob.download_as_bytes()
        img = Image.open(io.BytesIO(img_bytes))

        logging.info(f"Image {file_name} téléchargée et prête pour l'analyse.")

        # Detect quality issues
        is_blurry = detect_blur(img)
        has_glare = detect_glare(img)
        low_contrast = detect_low_contrast(img)
        
        quality_notes = []
        if is_blurry: quality_notes.append("Blurry")
        if has_glare: quality_notes.append("Glare")
        if low_contrast: quality_notes.append("Low Contrast")
        
        if quality_notes:
            logging.warning(f"Image {file_name} quality issues: {', '.join(quality_notes)}")

        # Préparer le modèle et le prompt pour Gemini
        model = genai.GenerativeModel('gemini-2.5-flash')

        with open('prompt.txt', 'r') as f:
            prompt = f.read()

        prompt_parts = [
            img,
            prompt
        ]

        # Générer le contenu
        logging.info("Sending request to Gemini API...")
        response = model.generate_content(prompt_parts, generation_config=genai.types.GenerationConfig(temperature=0.2))
        logging.info("Received response from Gemini API.")

        # Extraire et nettoyer la réponse JSON
        response_text = response.text.strip()

        # S'assurer que la réponse est bien du JSON
        try:
            if response_text.startswith("```json"):
                response_text = response_text[7:]
            if response_text.endswith("```"):
                response_text = response_text[:-3]

            json_data = json.loads(response_text)
            json_data['image_uri'] = f'gs://{bucket_name}/{file_name}'
            
            # Combine image analysis with Gemini confidence
            gemini_confidence = json_data.get('confidence', 'High')
            
            # Logic: If Gemini is not confident, OR if we detect significant issues, flag it.
            # However, user feedback suggests "is_blurry" was false even when confidence was Medium.
            # So we should trust Gemini's confidence more.
            
            json_data['is_blurry'] = is_blurry # Keep raw detection
            json_data['has_glare'] = has_glare
            json_data['low_contrast'] = low_contrast
            
            # Create a master "quality_check" field
            is_quality_ok = True
            if gemini_confidence != "High":
                is_quality_ok = False
            if is_blurry or has_glare or low_contrast:
                # We can be a bit more lenient if Gemini is confident, but let's flag it for now
                # Or maybe just add to notes
                pass
                
            json_data['quality_check_passed'] = is_quality_ok
            
            # Append our detection notes to Gemini's notes
            existing_notes = json_data.get('notes', "")
            new_notes = ", ".join(quality_notes)
            if existing_notes and new_notes:
                json_data['notes'] = f"{existing_notes}. Detected: {new_notes}"
            elif new_notes:
                json_data['notes'] = f"Detected: {new_notes}"
            
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
            result_filename = f"{prefix}_{first_name}_{last_name}.json"

            # Uploader le résultat JSON dans le bucket de destination
            destination_bucket_name = "jae-scan-results"    # Need to make this a parameter
            destination_bucket = storage_client.bucket(destination_bucket_name)
            result_blob = destination_bucket.blob(result_filename)
            logging.info(f"Uploading JSON file {result_filename} to bucket {destination_bucket_name}...")
            result_blob.upload_from_string(json.dumps(json_data, indent=4), content_type='application/json')
            logging.info("JSON file uploaded successfully.")

            logging.info(f"Résultat JSON sauvegardé sous {result_filename} dans {destination_bucket_name}")

        except json.JSONDecodeError:
            logging.error(f"Erreur: La réponse de Gemini n'est pas un JSON valide. Réponse reçue:\n{response.text}")
        except Exception as e:
            logging.error(f"Erreur lors de la sauvegarde du résultat JSON : {e}")

    except Exception as e:
        logging.error(f"Erreur lors du traitement de l'image {file_name} : {e}")
    finally:
        # Supprimer le fichier .LOCK
        if lock_blob.exists():
            logging.info(f"Deleting lock file: {lock_filename}")
            lock_blob.delete()

def get_participants_data():
    participants = {}
    bucket_name = "jae-scan-results"
    bucket = storage_client.bucket(bucket_name)
    blobs = bucket.list_blobs()

    for blob in blobs:
        if blob.name.startswith('LIC_') and blob.name.endswith('.json'):
            data = json.loads(blob.download_as_string())
            license_no = data.get("licence")
            if license_no:
                image_uri = data.get("image_uri")
                http_url = None
                if not image_uri:
                    logging.error(f"Image URI not found in JSON data for license {license_no}.")
                else:
                    # Convert gs:// URI to https://storage.cloud.google.com/ URL
                    parts = image_uri.split('/')
                    if len(parts) >= 4 and parts[0] == 'gs:':
                        image_bucket_name = parts[2]
                        image_file_name = '/'.join(parts[3:])
                        http_url = f'https://storage.cloud.google.com/{image_bucket_name}/{image_file_name}'
                    else:
                        logging.error(f"Invalid image URI format: {image_uri}")

                participants[license_no] = {
                    "nom": data.get("nom"),
                    "prenom": data.get("prenom"),
                    "licence": license_no,
                    "annee_validite": data.get("annee_validite"),
                    "classement": data.get("classement"),
                    "club": data.get("club"),
                    "statut": data.get("statut"),
                    "id_checked": False,
                    "image_uri": http_url
                }

    blobs = bucket.list_blobs() # Re-list to iterate again
    for blob in blobs:
        if blob.name.startswith('PID_') and blob.name.endswith('.json'):
            # Assuming PID filename format is PID_PRENOM-NOM.json
            parts = blob.name.replace('PID_', '').replace('.json', '').split('_')
            if len(parts) == 2:
                prenom_pid, nom_pid = parts
                logging.info(f"PID file: Original prenom='{prenom_pid}', nom='{nom_pid}'")
                normalized_prenom_pid = normalize_name(prenom_pid)
                normalized_nom_pid = normalize_name(nom_pid)
                logging.info(f"PID file: Normalized prenom='{normalized_prenom_pid}', nom='{normalized_nom_pid}'")
                for lic, participant in participants.items():
                    prenom_lic = participant['prenom']
                    nom_lic = participant['nom']
                    normalized_prenom_lic = normalize_name(prenom_lic)
                    normalized_nom_lic = normalize_name(nom_lic)
                    logging.info(f"  LIC participant: Original prenom='{prenom_lic}', nom='{nom_lic}'")
                    logging.info(f"  LIC participant: Normalized prenom='{normalized_prenom_lic}', nom='{normalized_nom_lic}'")
                    if normalized_prenom_lic == normalized_prenom_pid and normalized_nom_lic == normalized_nom_pid:
                        logging.info(f"  Match found for {prenom_lic} {nom_lic}")
                        participant['id_checked'] = True
                        break
                    else:
                        logging.info(f"  No match for {prenom_lic} {nom_lic}")
    return participants

@app.route('/api/participants', methods=['GET'])
def api_participants():
    participants = get_participants_data()
    return jsonify(list(participants.values()))

@app.route('/', methods=['GET'])
def serve_page():
    participants = get_participants_data()
    debug_mode = request.args.get('debug', 'false').lower() == 'true'
    return render_template('index.html', participants=list(participants.values()), debug=debug_mode)

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
