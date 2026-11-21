import datetime as dt
import io
import json
import logging
import os
import re
import subprocess
import unicodedata
import uuid

from flask import Flask, jsonify, render_template, request
from google.api_core.exceptions import NotFound, PreconditionFailed
from google.cloud import storage
import google.generativeai as genai
from PIL import Image

# Configure logging
logging.basicConfig(level=logging.INFO)

SCAN_BUCKET_NAME = os.getenv("SCAN_BUCKET_NAME", "jae-scan-bucket")
RESULTS_BUCKET_NAME = os.getenv("RESULTS_BUCKET_NAME", "jae-scan-results")
GEMINI_MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-4-hydrogen")
SCANNER_API_KEY = os.getenv("SCANNER_API_KEY")

TRANSLITERATION_MAP = str.maketrans({
    "œ": "oe",
    "æ": "ae",
    "ß": "ss",
    "ø": "o",
    "đ": "d",
    "ł": "l",
})


def normalize_name(name):
    """Normalise un nom/prénom pour le rapprochement (sans accents, ponctuation ni espaces)."""
    if not name:
        return ""
    text = str(name).strip().lower().translate(TRANSLITERATION_MAP)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]", "", text)


def slugify_filename_part(value, default="unknown"):
    """Produit un segment ASCII sûr pour un nom de fichier GCS."""
    normalized = normalize_name(value)
    return normalized[:40] if normalized else default


def extract_first_name_tokens(prenom, prenoms=None):
    """Retourne les formes normalisées possibles du/des prénoms d'une personne."""
    tokens = set()
    if prenoms and isinstance(prenoms, list):
        for p in prenoms:
            norm = normalize_name(p)
            if norm:
                tokens.add(norm)
        joined = normalize_name(" ".join(str(p) for p in prenoms if p))
        if joined:
            tokens.add(joined)

    if prenom:
        full_norm = normalize_name(prenom)
        if full_norm:
            tokens.add(full_norm)
        for part in re.split(r"[\s,;]+", str(prenom).strip()):
            part_norm = normalize_name(part)
            if part_norm:
                tokens.add(part_norm)
    return tokens


def names_match(lic_nom, lic_prenom, pid_data):
    """Rapproche une licence FFT avec les données JSON d'une pièce d'identité."""
    lic_nom_norm = normalize_name(lic_nom)
    lic_prenom_tokens = extract_first_name_tokens(lic_prenom)
    if not lic_nom_norm or not lic_prenom_tokens:
        return False

    pid_surnames = {
        normalize_name(pid_data.get("nom")),
        normalize_name(pid_data.get("nom_usage")),
    }
    pid_surnames.discard("")
    pid_prenom_tokens = extract_first_name_tokens(
        pid_data.get("prenom"),
        pid_data.get("prenoms"),
    )

    if not pid_surnames or not pid_prenom_tokens:
        return False

    # 1. Correspondance nominale (nom de naissance OU nom d'usage) + prénom / premier prénom
    if lic_nom_norm in pid_surnames and (lic_prenom_tokens & pid_prenom_tokens):
        return True

    # 2. Tolérance inversion nom / prénom (fréquent sur certains passeports étrangers)
    if lic_nom_norm in pid_prenom_tokens and (lic_prenom_tokens & pid_surnames):
        return True

    return False


def is_authorized_request():
    """Vérifie la clé API partagée si SCANNER_API_KEY est configurée dans l'environnement."""
    if not SCANNER_API_KEY:
        return True
    provided = request.headers.get("X-API-Key")
    if not provided:
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            provided = auth_header[7:].strip()
    return provided == SCANNER_API_KEY


# Initialiser Flask
app = Flask(__name__)

# Configurer l'API Gemini
try:
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        logging.warning("Avertissement : La variable d'environnement GOOGLE_API_KEY n'est pas définie.")
    genai.configure(api_key=api_key)
except Exception as e:
    logging.error(f"Erreur lors de la configuration de l'API Gemini : {e}")

# Initialiser le client Google Cloud Storage
storage_client = storage.Client()


@app.route("/", methods=["POST"])
def index():
    # Les événements Cloud Storage (Eventarc) sont envoyés en tant que requêtes POST
    envelope = request.get_json(silent=True)
    if not envelope:
        msg = "no Pub/Sub message received"
        logging.error(f"error: {msg}")
        return f"Bad Request: {msg}", 400

    try:
        bucket_name = envelope["bucket"]
        file_name = envelope["name"]

        handle_storage_event(bucket_name, file_name)
        return "", 204
    except KeyError as e:
        logging.error(f"Champ manquant dans l'événement GCS : {e}")
        return f"Bad Request: missing {e}", 400
    except Exception as e:
        logging.error(f"Erreur lors du traitement du message : {e}")
        return "", 500


def handle_storage_event(bucket_name, file_name):
    logging.info(f"Fichier {file_name} uploadé dans le bucket {bucket_name}.")

    lock_filename = f"{file_name}.LOCK"
    destination_bucket = storage_client.bucket(RESULTS_BUCKET_NAME)
    lock_blob = destination_bucket.blob(lock_filename)
    lock_acquired = False

    try:
        # Acquisition atomique du verrou (évite les race conditions multi-threads / retries Eventarc)
        try:
            lock_blob.upload_from_string("", if_generation_match=0)
            lock_acquired = True
            logging.info(f"Acquired atomic lock file: {lock_filename}")
        except PreconditionFailed:
            logging.info(f"Lock file {lock_filename} already exists. Skipping duplicate event.")
            return

        # Télécharger l'image depuis le bucket source
        source_bucket = storage_client.bucket(bucket_name)
        blob = source_bucket.blob(file_name)
        img_bytes = blob.download_as_bytes()
        img = Image.open(io.BytesIO(img_bytes))

        logging.info(f"Image {file_name} téléchargée et prête pour l'analyse.")

        # Préparer le modèle et le prompt pour Gemini
        model = genai.GenerativeModel(GEMINI_MODEL_NAME)

        prompt_path = os.path.join(os.path.dirname(__file__), "prompt.txt")
        with open(prompt_path, "r", encoding="utf-8") as f:
            prompt = f.read()

        prompt_parts = [img, prompt]

        # Générer le contenu en JSON strict
        logging.info(f"Sending request to Gemini API ({GEMINI_MODEL_NAME})...")
        response = model.generate_content(
            prompt_parts,
            generation_config=genai.types.GenerationConfig(
                temperature=0.2,
                response_mime_type="application/json",
            ),
        )
        logging.info("Received response from Gemini API.")

        response_text = (response.text or "").strip()

        try:
            if response_text.startswith("```json"):
                response_text = response_text[7:].strip()
            elif response_text.startswith("```"):
                response_text = response_text[3:].strip()
            if response_text.endswith("```"):
                response_text = response_text[:-3].strip()

            json_data = json.loads(response_text)
            json_data["image_uri"] = f"gs://{bucket_name}/{file_name}"

            first_name = slugify_filename_part(json_data.get("prenom"))
            last_name = slugify_filename_part(json_data.get("nom"))
            doc_type = (json_data.get("type") or "unknown").lower()

            if doc_type == "licence":
                prefix = "LIC"
            elif doc_type == "identite":
                prefix = "PID"
            else:
                prefix = "UNKNOWN"

            short_id = uuid.uuid4().hex[:8]
            result_filename = f"{prefix}_{first_name}_{last_name}_{short_id}.json"

            result_blob = destination_bucket.blob(result_filename)
            logging.info(f"Uploading JSON file {result_filename} to bucket {RESULTS_BUCKET_NAME}...")
            result_blob.upload_from_string(
                json.dumps(json_data, indent=4, ensure_ascii=False),
                content_type="application/json",
            )
            logging.info(f"Résultat JSON sauvegardé sous {result_filename} dans {RESULTS_BUCKET_NAME}")

        except json.JSONDecodeError:
            logging.error(f"Erreur: La réponse de Gemini n'est pas un JSON valide. Réponse reçue:\n{response.text}")
        except Exception as e:
            logging.error(f"Erreur lors de la sauvegarde du résultat JSON : {e}")

    except Exception as e:
        logging.error(f"Erreur lors du traitement de l'image {file_name} : {e}")
    finally:
        if lock_acquired:
            try:
                logging.info(f"Deleting lock file: {lock_filename}")
                lock_blob.delete()
            except NotFound:
                pass


def gs_uri_to_https(image_uri):
    if not image_uri:
        return None
    parts = image_uri.split("/")
    if len(parts) >= 4 and parts[0] == "gs:":
        image_bucket_name = parts[2]
        image_file_name = "/".join(parts[3:])
        return f"https://storage.cloud.google.com/{image_bucket_name}/{image_file_name}"
    logging.error(f"Invalid image URI format: {image_uri}")
    return None


def get_participants_data():
    participants = {}
    pid_records = []
    bucket = storage_client.bucket(RESULTS_BUCKET_NAME)

    for blob in bucket.list_blobs():
        if not blob.name.endswith(".json"):
            continue

        if blob.name.startswith("LIC_"):
            try:
                data = json.loads(blob.download_as_string())
            except Exception as e:
                logging.error(f"Impossible de lire {blob.name}: {e}")
                continue

            license_no = data.get("licence")
            participant_key = license_no or f"TEMP_{slugify_filename_part(data.get('nom'))}_{slugify_filename_part(data.get('prenom'))}"
            if not license_no:
                logging.warning(f"Licence manquante (ex. écran Ten'Up partiel) dans {blob.name}; clé temporaire {participant_key}")

            participants[participant_key] = {
                "nom": data.get("nom"),
                "prenom": data.get("prenom"),
                "licence": license_no or "INCOMPLET",
                "licence_incomplete": not bool(license_no),
                "document_subtype": data.get("document_subtype"),
                "champs_manquants": data.get("champs_manquants") or [],
                "annee_validite": data.get("annee_validite"),
                "classement": data.get("classement"),
                "club": data.get("club"),
                "statut": data.get("statut"),
                "id_checked": False,
                "image_uri": gs_uri_to_https(data.get("image_uri")),
            }

        elif blob.name.startswith("PID_"):
            try:
                pid_data = json.loads(blob.download_as_string())
                pid_records.append((blob.name, pid_data))
            except Exception as e:
                logging.error(f"Impossible de lire {blob.name}: {e}")

    for blob_name, pid_data in pid_records:
        for participant in participants.values():
            if names_match(participant.get("nom"), participant.get("prenom"), pid_data):
                logging.info(
                    f"Match PID ({blob_name}) -> {participant.get('prenom')} {participant.get('nom')}"
                )
                participant["id_checked"] = True
                break

    return participants


@app.route("/api/upload-url", methods=["POST"])
def create_upload_url():
    """Génère une GCS Signed URL v4 courte pour upload direct (Android) sans passer par jae-scanner."""
    if not is_authorized_request():
        return jsonify({"error": "Unauthorized"}), 401

    payload = request.get_json(silent=True) or {}
    content_type = payload.get("content_type", "image/jpeg")
    if content_type not in ("image/jpeg", "image/png", "image/webp"):
        return jsonify({"error": "Unsupported content_type"}), 400

    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[content_type]
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
    object_name = f"{timestamp}-{uuid.uuid4().hex[:8]}-capture.{ext}"

    try:
        bucket = storage_client.bucket(SCAN_BUCKET_NAME)
        blob = bucket.blob(object_name)
        signed_url = blob.generate_signed_url(
            version="v4",
            expiration=dt.timedelta(minutes=5),
            method="PUT",
            content_type=content_type,
        )
        return jsonify({
            "upload_url": signed_url,
            "object_name": object_name,
            "bucket": SCAN_BUCKET_NAME,
            "content_type": content_type,
            "expires_in_seconds": 300,
        })
    except Exception as e:
        logging.error(f"Impossible de générer une Signed URL GCS : {e}")
        return jsonify({"error": "Impossible de générer une URL d'upload sécurisée"}), 500


@app.route("/api/participants", methods=["GET"])
def api_participants():
    participants = get_participants_data()
    return jsonify(list(participants.values()))


@app.route("/", methods=["GET"])
def serve_page():
    participants = get_participants_data()
    debug_mode = request.args.get("debug", "false").lower() == "true"
    build_info = get_build_info()
    return render_template(
        "index.html",
        participants=list(participants.values()),
        debug=debug_mode,
        build_info=build_info,
    )


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


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
