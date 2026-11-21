from datetime import datetime, timezone
import io
import logging
import os
import subprocess
import uuid

from flask import Flask, jsonify, render_template, request
from flask_cors import CORS
from google.cloud import storage
from PIL import Image
from werkzeug.utils import secure_filename

logging.basicConfig(level=logging.INFO)

SCAN_BUCKET_NAME = os.getenv("SCAN_BUCKET_NAME", "jae-scan-bucket")
SCANNER_API_KEY = os.getenv("SCANNER_API_KEY")

# Initialiser Flask pour servir les fichiers statiques depuis le dossier 'static'
# et les templates depuis le dossier 'templates'
app = Flask(__name__, static_folder="static", template_folder="templates")
CORS(app)


def is_authorized_request():
    """Vérifie la clé API partagée si SCANNER_API_KEY est configurée."""
    if not SCANNER_API_KEY:
        return True
    provided = request.headers.get("X-API-Key")
    if not provided:
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            provided = auth_header[7:].strip()
    return provided == SCANNER_API_KEY


@app.route("/")
def index():
    build_info = get_build_info()
    return render_template("index.html", build_info=build_info)


def get_build_info():
    """Retrieves build information (commit hash and branch name)."""
    commit_hash = os.getenv("GIT_COMMIT") or os.getenv("BUILD_NUMBER")
    branch_name = os.getenv("GIT_BRANCH") or os.getenv("BRANCH_NAME")

    if not commit_hash or not branch_name:
        try:
            if not commit_hash:
                commit_hash = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"]).strip().decode("utf-8")
            if not branch_name:
                branch_name = subprocess.check_output(["git", "rev-parse", "--abbrev-ref", "HEAD"]).strip().decode("utf-8")
        except Exception as e:
            logging.warning(f"Failed to retrieve git info: {e}")
            if not commit_hash:
                commit_hash = "Unknown"
            if not branch_name:
                branch_name = "Unknown"

    return {
        "commit_hash": commit_hash,
        "branch_name": branch_name,
    }


@app.route("/scan", methods=["POST"])
def scan_image():
    if not is_authorized_request():
        return jsonify({"error": "Non autorisé"}), 401

    if "file" not in request.files:
        return jsonify({"error": "Aucun fichier n'a été envoyé"}), 400

    file = request.files["file"]

    if not file or file.filename == "":
        return jsonify({"error": "Aucun fichier n'a été sélectionné"}), 400

    try:
        img_bytes = file.read()
        if not img_bytes:
            return jsonify({"error": "Le fichier envoyé est vide"}), 400

        logging.info(f"Taille du fichier '{file.filename}' reçu : {len(img_bytes)} bytes")
        img = Image.open(io.BytesIO(img_bytes))
        img.verify()
    except Exception as e:
        logging.error(f"Image invalide reçue : {e}")
        return jsonify({"error": f"Image invalide : {str(e)}"}), 400

    safe_name = secure_filename(file.filename) or "capture.jpg"
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
    unique_filename = f"{timestamp}-{uuid.uuid4().hex[:8]}-{safe_name}"

    try:
        storage_client = storage.Client()
        bucket = storage_client.bucket(SCAN_BUCKET_NAME)
        blob = bucket.blob(unique_filename)
        blob.upload_from_string(img_bytes, content_type=file.content_type or "image/jpeg")
        logging.info(f"Image {unique_filename} uploadée avec succès sur {SCAN_BUCKET_NAME}")
    except Exception as e:
        logging.error(f"Erreur lors de l'upload sur Google Cloud Storage : {e}")
        return jsonify({"error": f"Échec de l'upload vers Cloud Storage : {str(e)}"}), 502

    return jsonify({"uploaded_file": unique_filename}), 200


if __name__ == "__main__":
    # Le port 5001 est utilisé pour éviter les conflits avec d'autres services
    app.run(debug=True, port=5001)
