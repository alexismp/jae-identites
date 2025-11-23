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

from PIL import ImageFilter, ImageStat

def crop_center(image, crop_percent=0.5):
    width, height = image.size
    new_width = width * crop_percent
    new_height = height * crop_percent
    left = (width - new_width) / 2
    top = (height - new_height) / 2
    right = (width + new_width) / 2
    bottom = (height + new_height) / 2
    return image.crop((left, top, right, bottom))

def detect_blur(image, threshold=500):
    try:
        # Crop to center to avoid background noise
        image = crop_center(image)
        gray_image = image.convert('L')
        edges = gray_image.filter(ImageFilter.FIND_EDGES)
        stat = ImageStat.Stat(edges)
        variance = stat.var[0]
        logging.info(f"Blur score: {variance}")
        return variance, variance < threshold
    except Exception as e:
        logging.error(f"Error in detect_blur: {e}")
        return 0, False

def detect_glare(image, threshold=250, pixel_percent=0.05):
    try:
        gray_image = image.convert('L')
        hist = gray_image.histogram()
        bright_pixels = sum(hist[threshold:])
        total_pixels = image.width * image.height
        ratio = bright_pixels / total_pixels
        logging.info(f"Glare ratio: {ratio}")
        return ratio, ratio > pixel_percent
    except Exception as e:
        logging.error(f"Error in detect_glare: {e}")
        return 0, False

def detect_low_contrast(image, threshold=50):
    try:
        gray_image = image.convert('L')
        extrema = gray_image.getextrema()
        if extrema:
            min_val, max_val = extrema
            contrast_range = max_val - min_val
            logging.info(f"Contrast range: {contrast_range}")
            return contrast_range, contrast_range < threshold
        return 0, False
    except Exception as e:
        logging.error(f"Error in detect_low_contrast: {e}")
        return 0, False

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

            # Quality Checks
            blur_score, is_blurry = detect_blur(img)
            glare_ratio, has_glare = detect_glare(img)
            contrast_range, low_contrast = detect_low_contrast(img)

            errors = []
            if is_blurry:
                errors.append(f"Image trop floue (Score: {blur_score:.0f} < 500)")
            if has_glare:
                errors.append(f"Reflet détecté (Ratio: {glare_ratio:.2f})")
            if low_contrast:
                errors.append(f"Contraste trop faible (Range: {contrast_range})")

            if errors:
                error_msg = "Qualité insuffisante : " + ", ".join(errors)
                logging.warning(f"Image rejected: {error_msg}")
                return jsonify({"error": error_msg}), 400

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