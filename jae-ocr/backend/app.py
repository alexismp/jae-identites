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
from google import genai
from google.api_core.exceptions import NotFound, PreconditionFailed
import google.auth
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.cloud import storage
from google.genai import types
from PIL import Image

# Configure logging
logging.basicConfig(level=logging.INFO)

GCP_PROJECT = os.getenv("GCP_PROJECT", os.getenv("GOOGLE_CLOUD_PROJECT", "alexismp-runner"))
VERTEX_LOCATION = os.getenv("VERTEX_LOCATION", "global")
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

# Initialiser le client Vertex AI (authentification via le compte de service / ADC, sans clé API)
genai_client = genai.Client(
    vertexai=True,
    project=GCP_PROJECT,
    location=VERTEX_LOCATION,
)

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


def write_scan_status(bucket, file_name, payload):
    """Enregistre le statut courant du traitement OCR (processing/done/error) pour suivi temps réel."""
    try:
        status_blob = bucket.blob(f"STATUS_{file_name}.json")
        data = {"file_name": file_name, **payload}
        status_blob.upload_from_string(
            json.dumps(data, ensure_ascii=False),
            content_type="application/json",
        )
    except Exception as e:
        logging.warning(f"Impossible d'écrire le statut OCR pour {file_name} : {e}")


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

        write_scan_status(destination_bucket, file_name, {"status": "processing"})

        # Télécharger l'image depuis le bucket source
        source_bucket = storage_client.bucket(bucket_name)
        blob = source_bucket.blob(file_name)
        img_bytes = blob.download_as_bytes()
        img = Image.open(io.BytesIO(img_bytes))

        logging.info(f"Image {file_name} téléchargée et prête pour l'analyse.")

        # Préparer le prompt et appeler Vertex AI (Gemini) en JSON strict
        prompt_path = os.path.join(os.path.dirname(__file__), "prompt.txt")
        with open(prompt_path, "r", encoding="utf-8") as f:
            prompt = f.read()

        logging.info(f"Sending request to Vertex AI ({GEMINI_MODEL_NAME} @ {GCP_PROJECT}/{VERTEX_LOCATION})...")
        response = genai_client.models.generate_content(
            model=GEMINI_MODEL_NAME,
            contents=[img, prompt],
            config=types.GenerateContentConfig(
                temperature=0.2,
                response_mime_type="application/json",
            ),
        )
        logging.info("Received response from Vertex AI.")

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
            write_scan_status(
                destination_bucket,
                file_name,
                {
                    "status": "done",
                    "type": doc_type,
                    "document_subtype": json_data.get("document_subtype"),
                    "nom": json_data.get("nom"),
                    "prenom": json_data.get("prenom"),
                    "licence": json_data.get("licence"),
                    "result_file": result_filename,
                },
            )

        except json.JSONDecodeError:
            msg = "La réponse de Gemini n'est pas un JSON valide."
            logging.error(f"Erreur: {msg} Réponse reçue:\n{response.text}")
            write_scan_status(destination_bucket, file_name, {"status": "error", "error": msg})
        except Exception as e:
            logging.error(f"Erreur lors de la sauvegarde du résultat JSON : {e}")
            write_scan_status(destination_bucket, file_name, {"status": "error", "error": str(e)})

    except Exception as e:
        logging.error(f"Erreur lors du traitement de l'image {file_name} : {e}")
        write_scan_status(destination_bucket, file_name, {"status": "error", "error": str(e)})
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
        sign_kwargs = {}
        credentials, _ = google.auth.default()
        if not getattr(credentials, "signer", None):
            credentials.refresh(GoogleAuthRequest())
            sign_kwargs["service_account_email"] = credentials.service_account_email
            sign_kwargs["access_token"] = credentials.token

        signed_url = blob.generate_signed_url(
            version="v4",
            expiration=dt.timedelta(minutes=5),
            method="PUT",
            content_type=content_type,
            **sign_kwargs,
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


@app.route("/api/scan-status/<path:object_name>", methods=["GET"])
def get_scan_status(object_name):
    """Retourne l'état du traitement OCR asynchrone (pending/processing/done/error) pour un fichier uploadé."""
    try:
        bucket = storage_client.bucket(RESULTS_BUCKET_NAME)
        status_blob = bucket.blob(f"STATUS_{object_name}.json")
        if not status_blob.exists():
            return jsonify({"status": "pending", "file_name": object_name}), 200
        return jsonify(json.loads(status_blob.download_as_string())), 200
    except Exception as e:
        logging.error(f"Erreur lors de la lecture du statut OCR pour {object_name} : {e}")
        return jsonify({"status": "error", "error": str(e)}), 500


def load_debug_participants():
    """Charge le jeu de données de test local (extrait des buckets) pour ?debug=true."""
    test_data_path = os.path.join(os.path.dirname(__file__), "test_data", "participants.json")
    try:
        with open(test_data_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logging.error(f"Impossible de charger le jeu de test {test_data_path} : {e}")
        return []


@app.route("/api/reset-match", methods=["POST"])
def reset_match():
    """Archive les fichiers actifs de jae-scan-results sous archive/<timestamp>/ pour repartir d'une rencontre vierge."""
    if not is_authorized_request():
        return jsonify({"error": "Unauthorized"}), 401

    archive_prefix = f"archive/{dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d_%H-%M-%S')}/"
    archived_count = 0
    try:
        bucket = storage_client.bucket(RESULTS_BUCKET_NAME)
        active_prefixes = ("LIC_", "PID_", "UNKNOWN_", "STATUS_", "ROSTER_")
        for blob in list(bucket.list_blobs()):
            if "/" in blob.name:
                continue
            if blob.name.startswith(active_prefixes) or blob.name.endswith(".LOCK"):
                bucket.copy_blob(blob, bucket, f"{archive_prefix}{blob.name}")
                blob.delete()
                archived_count += 1
        logging.info(f"Rencontre réinitialisée : {archived_count} fichiers archivés sous {archive_prefix}")
        return jsonify({
            "status": "reset",
            "archived_count": archived_count,
            "archive_prefix": archive_prefix,
        }), 200
    except Exception as e:
        logging.error(f"Erreur lors de la réinitialisation de la rencontre : {e}")
        return jsonify({"error": str(e)}), 500


def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-API-Key, Authorization"
    return response


@app.route("/api/tenup/extract-roster", methods=["POST", "OPTIONS"])
def extract_tenup_roster():
    """Extrait les noms/prénoms des joueurs des 2 équipes depuis les textes capturés par l'extension Chrome Ten'Up."""
    if request.method == "OPTIONS":
        return add_cors_headers(app.make_response(("", 204)))

    if not is_authorized_request():
        return add_cors_headers(jsonify({"error": "Unauthorized"})), 401

    payload = request.get_json(silent=True) or {}
    tenup_url = (payload.get("tenupUrl") or "").strip()
    match_text = (payload.get("matchText") or "")[:12000]
    team1_text = (payload.get("team1Text") or "")[:15000]
    team2_text = (payload.get("team2Text") or "")[:15000]

    if not (match_text or team1_text or team2_text):
        return add_cors_headers(jsonify({"error": "Aucun contenu Ten'Up fourni"})), 400

    prompt = f"""Tu analyses le texte extrait de pages officielles Ten'Up (Fédération Française de Tennis) d'une rencontre par équipes.
Extrais les noms des deux équipes ainsi que la liste complète des joueurs (nom en MAJUSCULES, prénom, classement si présent) pour chacune des deux équipes.
Ne devine jamais de joueur absent du texte.

Retourne UNIQUEMENT un JSON valide de cette forme :
{{
  "team1Name": "NOM CLUB EQUIPE 1",
  "team1Players": [{{"nom": "MARTIN", "prenom": "Léa", "classement": "15/2"}}],
  "team2Name": "NOM CLUB EQUIPE 2",
  "team2Players": [{{"nom": "DUPONT", "prenom": "Marc", "classement": "15/4"}}]
}}

--- PAGE RENCONTRE ---
{match_text}

--- PAGE EQUIPE 1 ---
{team1_text}

--- PAGE EQUIPE 2 ---
{team2_text}
"""

    try:
        response = genai_client.models.generate_content(
            model=GEMINI_MODEL_NAME,
            contents=[prompt],
            config=types.GenerateContentConfig(
                temperature=0.1,
                response_mime_type="application/json",
            ),
        )
        raw_text = (response.text or "").strip()
        if raw_text.startswith("```json"):
            raw_text = raw_text[7:].strip()
        elif raw_text.startswith("```"):
            raw_text = raw_text[3:].strip()
        if raw_text.endswith("```"):
            raw_text = raw_text[:-3].strip()

        roster = json.loads(raw_text)
        roster["tenupUrl"] = tenup_url
        roster["updatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()

        bucket = storage_client.bucket(RESULTS_BUCKET_NAME)
        roster_blob = bucket.blob("ROSTER_CURRENT.json")
        roster_blob.upload_from_string(
            json.dumps(roster, indent=2, ensure_ascii=False),
            content_type="application/json",
        )
        return add_cors_headers(jsonify(roster)), 200
    except Exception as e:
        logging.error(f"Erreur extraction compositions Ten'Up : {e}")
        return add_cors_headers(jsonify({"error": str(e)})), 500


@app.route("/api/tenup/roster", methods=["GET", "OPTIONS"])
def get_tenup_roster():
    """Retourne les compositions d'équipes Ten'Up importées pour la rencontre courante."""
    if request.method == "OPTIONS":
        return add_cors_headers(app.make_response(("", 204)))

    try:
        bucket = storage_client.bucket(RESULTS_BUCKET_NAME)
        roster_blob = bucket.blob("ROSTER_CURRENT.json")
        if not roster_blob.exists():
            return add_cors_headers(jsonify({})), 200
        return add_cors_headers(jsonify(json.loads(roster_blob.download_as_string()))), 200
    except Exception as e:
        logging.error(f"Erreur lecture ROSTER_CURRENT.json : {e}")
        return add_cors_headers(jsonify({})), 200


@app.route("/api/test-data", methods=["GET"])
def api_test_data():
    """Retourne le jeu de données de test local pour chargement explicite en mode debug."""
    return jsonify(load_debug_participants())


@app.route("/api/participants", methods=["GET"])
def api_participants():
    debug_mode = request.args.get("debug", "false").lower() == "true"
    if debug_mode:
        return jsonify([])
    participants = get_participants_data()
    return jsonify(list(participants.values()))


@app.route("/", methods=["GET"])
def serve_page():
    debug_mode = request.args.get("debug", "false").lower() == "true"
    # En mode debug (?debug=true), la rencontre démarre vierge ; l'utilisateur charge explicitement le jeu de test.
    participants_list = (
        []
        if debug_mode
        else list(get_participants_data().values())
    )
    build_info = get_build_info()
    return render_template(
        "index.html",
        participants=participants_list,
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
