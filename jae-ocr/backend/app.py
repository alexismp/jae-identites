import datetime as dt
import io
import json
import logging
import os
import re
import subprocess
import time
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

import match_store

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
    "0": "o",
    "1": "i",
    "5": "s",
    "8": "b",
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


def get_match_reset_at(bucket):
    """Retourne l'horodatage UTC de la dernière réinitialisation de rencontre, ou None."""
    try:
        reset_blob = bucket.blob("MATCH_RESET_AT.json")
        if not reset_blob.exists():
            return None
        data = json.loads(reset_blob.download_as_string())
        raw_ts = data.get("reset_at")
        if raw_ts:
            return dt.datetime.fromisoformat(raw_ts)
    except Exception as e:
        logging.warning(f"Impossible de lire MATCH_RESET_AT.json : {e}")
    return None


def handle_storage_event(bucket_name, file_name):
    logging.info(f"Fichier {file_name} uploadé dans le bucket {bucket_name}.")

    match_id, bare_name = match_store.parse_match_id_from_object_name(file_name)
    safe_lock_name = file_name.replace("/", "__")
    lock_filename = f"{safe_lock_name}.LOCK"
    destination_bucket = storage_client.bucket(RESULTS_BUCKET_NAME)
    lock_blob = destination_bucket.blob(lock_filename)
    lock_acquired = False

    def record_status(payload):
        if match_id:
            match_store.save_match_scan_status(match_id, file_name, payload)
        else:
            write_scan_status(destination_bucket, file_name, payload)

    try:
        source_bucket = storage_client.bucket(bucket_name)
        blob = source_bucket.blob(file_name)
        blob.reload()

        if not match_id:
            # Ignorer les retries Eventarc d'anciens scans antérieurs à la dernière « Nouvelle rencontre » (mode legacy GCS)
            reset_at = get_match_reset_at(destination_bucket)
            if reset_at and blob.time_created and blob.time_created < reset_at:
                logging.info(
                    f"Ignoré (retry ancien antérieur à Nouvelle rencontre {reset_at.isoformat()}) : {file_name}"
                )
                return

        # Ignorer les retries Eventarc si le fichier a déjà été traité avec succès
        if match_id:
            existing_fs_status = match_store.get_match_scan_status(match_id, file_name)
            if existing_fs_status and existing_fs_status.get("status") == "done":
                logging.info(f"Fichier déjà traité (Firestore done) : {file_name}. Retry Eventarc ignoré.")
                return
        else:
            status_blob = destination_bucket.blob(f"STATUS_{file_name}.json")
            if status_blob.exists():
                try:
                    existing_status = json.loads(status_blob.download_as_string())
                    if existing_status.get("status") == "done":
                        logging.info(f"Fichier déjà traité avec succès (STATUS done) : {file_name}. Retry Eventarc ignoré.")
                        return
                except Exception:
                    pass

        # Acquisition atomique du verrou (évite les race conditions multi-threads / retries Eventarc)
        try:
            lock_blob.upload_from_string("", if_generation_match=0)
            lock_acquired = True
            logging.info(f"Acquired atomic lock file: {lock_filename}")
        except PreconditionFailed:
            logging.info(f"Lock file {lock_filename} already exists. Skipping duplicate event.")
            return

        record_status({"status": "processing"})

        # Télécharger l'image depuis le bucket source
        img_bytes = blob.download_as_bytes()
        img = Image.open(io.BytesIO(img_bytes))

        logging.info(f"Image {file_name} téléchargée et prête pour l'analyse.")

        # Préparer le prompt et appeler Vertex AI (Gemini) en JSON strict
        prompt_path = os.path.join(os.path.dirname(__file__), "prompt.txt")
        with open(prompt_path, "r", encoding="utf-8") as f:
            prompt = f.read()

        logging.info(f"Sending request to Vertex AI ({GEMINI_MODEL_NAME} @ {GCP_PROJECT}/{VERTEX_LOCATION})...")
        response = None
        last_err = None
        for attempt in range(3):
            try:
                response = genai_client.models.generate_content(
                    model=GEMINI_MODEL_NAME,
                    contents=[img, prompt],
                    config=types.GenerateContentConfig(
                        temperature=0.2,
                        response_mime_type="application/json",
                    ),
                )
                break
            except Exception as api_err:
                last_err = api_err
                err_str = str(api_err)
                is_transient = ("429" in err_str or "RESOURCE_EXHAUSTED" in err_str or "503" in err_str or "UNAVAILABLE" in err_str)
                if is_transient and attempt < 2:
                    wait_s = 4 * (attempt + 1)
                    logging.warning(f"Erreur transitoire Vertex AI ({err_str[:120]}), nouvelle tentative dans {wait_s}s...")
                    time.sleep(wait_s)
                    continue
                raise
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
            doc_subtype = (json_data.get("document_subtype") or "").lower()

            if doc_type == "non_autorise" or doc_subtype in ("permis_conduire", "titre_sejour", "carte_sejour"):
                msg = "Document non autorisé (permis de conduire ou titre de séjour). Seuls CNI et passeport sont acceptés."
                logging.warning(f"Document refusé ({doc_subtype or doc_type}) pour {file_name}")
                record_status({"status": "error", "error": msg})
                match_store.log_activity("ocr_rejected", match_id=match_id, details={"file": file_name, "subtype": doc_subtype or doc_type}, severity="error")
                return

            if doc_type == "licence":
                raw_nom = (json_data.get("nom") or "").strip()
                raw_prenom = (json_data.get("prenom") or "").strip()
                if not raw_nom or not raw_prenom:
                    msg = "Attestation de licence incomplète : nom ou prénom illisible. Veuillez rescanner."
                    logging.warning(f"Licence rejetée (nom/prénom manquant) pour {file_name} : nom={raw_nom!r}, prenom={raw_prenom!r}")
                    record_status({"status": "error", "error": msg})
                    match_store.log_activity(
                        "ocr_licence_incomplete",
                        match_id=match_id,
                        details={"file": file_name, "nom": raw_nom or None, "prenom": raw_prenom or None},
                        severity="error",
                    )
                    return

                raw_comp = (json_data.get("niveau_competence") or "").strip()
                if raw_comp:
                    # Garder uniquement ce qui suit ARB: et stopper avant tout préfixe JA:
                    raw_comp = re.split(r"\bJA\s*:", raw_comp, maxsplit=1, flags=re.IGNORECASE)[0]
                    raw_comp = re.sub(r"^\s*ARB\s*:\s*", "", raw_comp, flags=re.IGNORECASE).strip(" ,;-")
                    json_data["niveau_competence"] = raw_comp or None
                else:
                    json_data["niveau_competence"] = None
                prefix = "LIC"
            elif doc_type == "identite":
                prefix = "PID"
            else:
                prefix = "UNKNOWN"

            short_id = uuid.uuid4().hex[:8]
            result_filename = f"{prefix}_{first_name}_{last_name}_{short_id}.json"

            if match_id:
                if prefix == "LIC":
                    match_store.save_match_licence(match_id, result_filename, json_data)
                elif prefix == "PID":
                    match_store.save_match_identity(match_id, result_filename, json_data)
                logging.info(f"Résultat Firestore sauvegardé ({result_filename}) dans matches/{match_id}")
            else:
                result_blob = destination_bucket.blob(result_filename)
                logging.info(f"Uploading JSON file {result_filename} to bucket {RESULTS_BUCKET_NAME}...")
                result_blob.upload_from_string(
                    json.dumps(json_data, indent=4, ensure_ascii=False),
                    content_type="application/json",
                )
                logging.info(f"Résultat JSON sauvegardé sous {result_filename} dans {RESULTS_BUCKET_NAME}")

            record_status(
                {
                    "status": "done",
                    "matchId": match_id,
                    "type": doc_type,
                    "document_subtype": json_data.get("document_subtype"),
                    "nom": json_data.get("nom"),
                    "prenom": json_data.get("prenom"),
                    "licence": json_data.get("licence"),
                    "niveau_competence": json_data.get("niveau_competence"),
                    "result_file": result_filename,
                },
            )
            match_store.log_activity(
                "ocr_completed",
                match_id=match_id,
                details={
                    "type": doc_type,
                    "subtype": json_data.get("document_subtype"),
                    "nom": json_data.get("nom"),
                    "prenom": json_data.get("prenom"),
                },
            )

        except json.JSONDecodeError:
            msg = "La réponse de Gemini n'est pas un JSON valide."
            logging.error(f"Erreur: {msg} Réponse reçue:\n{response.text}")
            record_status({"status": "error", "error": msg})
        except Exception as e:
            logging.error(f"Erreur lors de la sauvegarde du résultat JSON : {e}")
            record_status({"status": "error", "error": str(e)})

    except Exception as e:
        logging.error(f"Erreur lors du traitement de l'image {file_name} : {e}")
        record_status({"status": "error", "error": str(e)})
        match_store.log_activity("ocr_error", match_id=match_id, details={"file": file_name, "error": str(e)[:200]}, severity="error")
        err_str = str(e)
        if "429" in err_str or "RESOURCE_EXHAUSTED" in err_str or "503" in err_str or "UNAVAILABLE" in err_str:
            raise
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


def build_participants_from_records(roster_data, lic_records, pid_records):
    """Assemble la liste des participants à partir d'un roster Ten'Up, de licences LIC_ et de PID_."""
    participants = {}

    for blob_name, data in lic_records:
        if not (data.get("nom") or "").strip() or not (data.get("prenom") or "").strip():
            continue
        license_no = data.get("licence")
        participant_key = license_no or f"TEMP_{slugify_filename_part(data.get('nom'))}_{slugify_filename_part(data.get('prenom'))}"
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
            "niveau_competence": data.get("niveau_competence"),
            "id_checked": False,
            "image_uri": gs_uri_to_https(data.get("image_uri")),
        }

    # 1. Pré-remplir les fiches du roster Ten'Up
    if roster_data:
        for team_key, name_key in (("team1Players", "team1Name"), ("team2Players", "team2Name")):
            team_name = roster_data.get(name_key) or ""
            for rp in roster_data.get(team_key) or []:
                r_nom = rp.get("nom") or ""
                r_prenom = rp.get("prenom") or ""
                if not r_nom and not r_prenom:
                    continue
                existing_key = next(
                    (
                        k
                        for k, p in participants.items()
                        if names_match(p.get("nom"), p.get("prenom"), {"nom": r_nom, "prenom": r_prenom})
                    ),
                    None,
                )
                if existing_key:
                    if not participants[existing_key].get("classement") and rp.get("classement"):
                        participants[existing_key]["classement"] = rp.get("classement")
                    if not participants[existing_key].get("club") and team_name:
                        participants[existing_key]["club"] = team_name
                    continue

                roster_id = f"TENUP_{slugify_filename_part(r_nom)}_{slugify_filename_part(r_prenom)}"
                expected_slot = "team1" if team_key == "team1Players" else "team2"
                participants[roster_id] = {
                    "nom": r_nom,
                    "prenom": r_prenom,
                    "licence": f"Ten'Up ({roster_id.replace('TENUP_', '')})",
                    "licence_incomplete": False,
                    "document_subtype": "tenup_roster",
                    "expected_team_slot": expected_slot,
                    "team_slot": None,
                    "champs_manquants": [],
                    "annee_validite": None,
                    "classement": rp.get("classement") or None,
                    "club": team_name or None,
                    "statut": rp.get("statut") or None,
                    "id_checked": False,
                    "image_uri": None,
                }

    # 2. Cocher id_checked sur toute fiche existante (LIC_ ou joueur Ten'Up)
    for blob_name, pid_data in pid_records:
        for participant in participants.values():
            if names_match(participant.get("nom"), participant.get("prenom"), pid_data):
                participant["id_checked"] = True
                break

    # 3. Propager expected_team_slot sur les fiches LIC_ qui correspondent au roster Ten'Up
    if roster_data:
        for team_key, slot in (("team1Players", "team1"), ("team2Players", "team2")):
            for rp in roster_data.get(team_key) or []:
                for p in participants.values():
                    if not p.get("expected_team_slot") and names_match(p.get("nom"), p.get("prenom"), rp):
                        p["expected_team_slot"] = slot

    for p in participants.values():
        if p.get("id_checked") and p.get("expected_team_slot"):
            p["team_slot"] = p["expected_team_slot"]
        else:
            p["team_slot"] = None

    return participants


def get_match_participants_data(match_id):
    match_doc, lic_records, pid_records = match_store.load_match_records(match_id)
    if match_doc is None:
        return {}
    return build_participants_from_records(match_doc.get("roster") or {}, lic_records, pid_records)


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
                "niveau_competence": data.get("niveau_competence"),
                "id_checked": False,
                "image_uri": gs_uri_to_https(data.get("image_uri")),
            }

        elif blob.name.startswith("PID_"):
            try:
                pid_data = json.loads(blob.download_as_string())
                pid_records.append((blob.name, pid_data))
            except Exception as e:
                logging.error(f"Impossible de lire {blob.name}: {e}")

    # 1. Pré-remplir les fiches des joueurs issus du roster Ten'Up (qui seront validés dès le scan de leur pièce d'identité)
    try:
        roster_blob = bucket.blob("ROSTER_CURRENT.json")
        if roster_blob.exists():
            roster_data = json.loads(roster_blob.download_as_string())
            for team_key, name_key in (("team1Players", "team1Name"), ("team2Players", "team2Name")):
                team_name = roster_data.get(name_key) or ""
                for rp in roster_data.get(team_key) or []:
                    r_nom = rp.get("nom") or ""
                    r_prenom = rp.get("prenom") or ""
                    if not r_nom and not r_prenom:
                        continue
                    # Ne pas écraser une fiche déjà créée par un scan de licence LIC_ pour ce joueur
                    existing_key = next(
                        (
                            k
                            for k, p in participants.items()
                            if names_match(p.get("nom"), p.get("prenom"), {"nom": r_nom, "prenom": r_prenom})
                        ),
                        None,
                    )
                    if existing_key:
                        if not participants[existing_key].get("classement") and rp.get("classement"):
                            participants[existing_key]["classement"] = rp.get("classement")
                        if not participants[existing_key].get("club") and team_name:
                            participants[existing_key]["club"] = team_name
                        continue

                    roster_id = f"TENUP_{slugify_filename_part(r_nom)}_{slugify_filename_part(r_prenom)}"
                    expected_slot = "team1" if team_key == "team1Players" else "team2"
                    participants[roster_id] = {
                        "nom": r_nom,
                        "prenom": r_prenom,
                        "licence": f"Ten'Up ({roster_id.replace('TENUP_', '')})",
                        "licence_incomplete": False,
                        "document_subtype": "tenup_roster",
                        "expected_team_slot": expected_slot,
                        "team_slot": None,
                        "champs_manquants": [],
                        "annee_validite": None,
                        "classement": rp.get("classement") or None,
                        "club": team_name or None,
                        "statut": rp.get("statut") or None,
                        "id_checked": False,
                        "image_uri": None,
                    }
    except Exception as e:
        logging.warning(f"Impossible de lire ROSTER_CURRENT.json : {e}")

    # 2. Cocher id_checked sur toute fiche existante (LIC_ ou joueur Ten'Up).
    # Un PID_ seul sans licence ni présence sur la liste Ten'Up (ex. officiel) ne crée pas de fiche : il faudra aussi sa licence.
    for blob_name, pid_data in pid_records:
        for participant in participants.values():
            if names_match(participant.get("nom"), participant.get("prenom"), pid_data):
                logging.info(
                    f"Match PID ({blob_name}) -> {participant.get('prenom')} {participant.get('nom')}"
                )
                participant["id_checked"] = True
                break

    # 3. Propager expected_team_slot sur les fiches LIC_ qui correspondent au roster Ten'Up,
    #    et n'affecter team_slot (Équipe 1 / Équipe 2) QUE lorsque id_checked est True !
    try:
        roster_blob = bucket.blob("ROSTER_CURRENT.json")
        if roster_blob.exists():
            roster_data = json.loads(roster_blob.download_as_string())
            for team_key, slot in (("team1Players", "team1"), ("team2Players", "team2")):
                for rp in roster_data.get(team_key) or []:
                    for p in participants.values():
                        if not p.get("expected_team_slot") and names_match(p.get("nom"), p.get("prenom"), rp):
                            p["expected_team_slot"] = slot
    except Exception:
        pass

    for p in participants.values():
        if p.get("id_checked") and p.get("expected_team_slot"):
            p["team_slot"] = p["expected_team_slot"]
        else:
            p["team_slot"] = None

    return participants


@app.route("/api/upload-url", methods=["POST", "OPTIONS"])
def create_upload_url():
    """Génère une GCS Signed URL v4 courte pour upload direct (Android / Web) lié à la rencontre active de l'utilisateur."""
    if request.method == "OPTIONS":
        return add_cors_headers(app.make_response(("", 204)))

    user = match_store.verify_firebase_request(request)
    if not user and not is_authorized_request():
        return add_cors_headers(jsonify({"error": "Unauthorized"})), 401
    if user and not user.get("approved"):
        return add_cors_headers(jsonify({"error": "Compte en attente de validation par l'administrateur.", "code": "PENDING_APPROVAL"})), 403

    payload = request.get_json(silent=True) or {}
    content_type = payload.get("content_type", "image/jpeg")
    if content_type not in ("image/jpeg", "image/png", "image/webp"):
        return add_cors_headers(jsonify({"error": "Unsupported content_type"})), 400

    match_id = None
    if user:
        active_match = match_store.get_or_create_active_match(user)
        match_id = active_match["matchId"]
    elif payload.get("matchId"):
        match_id = match_store.sanitize_doc_id(payload.get("matchId"))

    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[content_type]
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
    base_name = f"{timestamp}-{uuid.uuid4().hex[:8]}-capture.{ext}"
    object_name = f"m_{match_id}/{base_name}" if match_id else base_name

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
        return add_cors_headers(jsonify({
            "upload_url": signed_url,
            "object_name": object_name,
            "matchId": match_id,
            "bucket": SCAN_BUCKET_NAME,
            "content_type": content_type,
            "expires_in_seconds": 300,
        }))
    except Exception as e:
        logging.error(f"Impossible de générer une Signed URL GCS : {e}")
        return add_cors_headers(jsonify({"error": "Impossible de générer une URL d'upload sécurisée"})), 500


@app.route("/api/identite/direct", methods=["POST", "OPTIONS"])
def submit_direct_identity():
    """Enregistre directement une pièce d'identité lue localement par MRZ sur Android, sans passer par le LLM."""
    if request.method == "OPTIONS":
        return add_cors_headers(app.make_response(("", 204)))

    user = match_store.verify_firebase_request(request)
    if not user and not is_authorized_request():
        return add_cors_headers(jsonify({"error": "Unauthorized"})), 401
    if user and not user.get("approved"):
        return add_cors_headers(jsonify({"error": "Compte en attente de validation par l'administrateur.", "code": "PENDING_APPROVAL"})), 403

    payload = request.get_json(silent=True) or {}
    nom = (payload.get("nom") or "").strip()
    prenom = (payload.get("prenom") or "").strip()
    if not nom or not prenom:
        return add_cors_headers(jsonify({"error": "Champs nom et prenom obligatoires"})), 400

    first_name = slugify_filename_part(prenom)
    last_name = slugify_filename_part(nom)
    short_id = uuid.uuid4().hex[:8]
    result_filename = f"PID_{first_name}_{last_name}_{short_id}.json"

    pid_record = {
        "type": "identite",
        "document_subtype": payload.get("document_subtype") or "mrz_local",
        "nom": nom,
        "prenom": prenom,
        "prenoms": [p for p in re.split(r"[\s,;]+", prenom) if p],
        "issuing_country": payload.get("issuing_country") or None,
        "check_digits_valid": bool(payload.get("check_digits_valid", True)),
        "source": payload.get("source") or "android_mrz",
        "image_uri": None,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }

    try:
        match_id = None
        if user:
            active_match = match_store.get_or_create_active_match(user)
            match_id = active_match["matchId"]
            match_store.save_match_identity(match_id, result_filename, pid_record)
            logging.info(f"Identité MRZ directe sauvegardée dans Firestore matches/{match_id} ({result_filename})")
            participants = get_match_participants_data(match_id)
            match_store.log_activity(
                "identity_mrz_direct",
                user=user,
                match_id=match_id,
                details={"nom": nom, "prenom": prenom, "subtype": pid_record["document_subtype"]},
            )
        else:
            bucket = storage_client.bucket(RESULTS_BUCKET_NAME)
            result_blob = bucket.blob(result_filename)
            result_blob.upload_from_string(
                json.dumps(pid_record, indent=4, ensure_ascii=False),
                content_type="application/json",
            )
            logging.info(f"Identité MRZ directe sauvegardée sous {result_filename} (sans LLM, legacy GCS)")
            participants = get_participants_data()

        matched = any(
            names_match(p.get("nom"), p.get("prenom"), pid_record)
            for p in participants.values()
        )

        return add_cors_headers(jsonify({
            "status": "done",
            "matchId": match_id,
            "result_file": result_filename,
            "nom": nom,
            "prenom": prenom,
            "matched": matched,
        })), 200
    except Exception as e:
        logging.error(f"Erreur lors de l'enregistrement direct de l'identité : {e}")
        return add_cors_headers(jsonify({"error": str(e)})), 500


@app.route("/api/scan-status/<path:object_name>", methods=["GET"])
def get_scan_status(object_name):
    """Retourne l'état du traitement OCR asynchrone (pending/processing/done/error) pour un fichier uploadé."""
    try:
        match_id, _ = match_store.parse_match_id_from_object_name(object_name)
        if match_id:
            fs_status = match_store.get_match_scan_status(match_id, object_name)
            if not fs_status:
                return jsonify({"status": "pending", "file_name": object_name, "matchId": match_id}), 200
            return jsonify(fs_status), 200

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

    now_utc = dt.datetime.now(dt.timezone.utc)
    archive_prefix = f"archive/{now_utc.strftime('%Y-%m-%d_%H-%M-%S')}/"
    archived_count = 0
    try:
        bucket = storage_client.bucket(RESULTS_BUCKET_NAME)
        active_prefixes = ("LIC_", "PID_", "UNKNOWN_", "STATUS_", "ROSTER_", "BOARD_")
        for blob in list(bucket.list_blobs()):
            if "/" in blob.name:
                continue
            if blob.name.startswith(active_prefixes) or blob.name.endswith(".LOCK"):
                bucket.copy_blob(blob, bucket, f"{archive_prefix}{blob.name}")
                blob.delete()
                archived_count += 1
        bucket.blob("MATCH_RESET_AT.json").upload_from_string(
            json.dumps({"reset_at": now_utc.isoformat()}),
            content_type="application/json",
        )
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


@app.route("/api/me", methods=["GET", "OPTIONS"])
def api_me():
    """Retourne le profil JAE connecté, sa rencontre active unique (si approuvé) et son historique."""
    if request.method == "OPTIONS":
        return add_cors_headers(app.make_response(("", 204)))

    user = match_store.verify_firebase_request(request)
    if not user:
        return add_cors_headers(jsonify({"error": "Authentication required"})), 401

    if not user.get("approved"):
        return add_cors_headers(jsonify({
            "user": user,
            "approved": False,
            "activeMatch": None,
            "matches": [],
        })), 200

    active_match = match_store.get_or_create_active_match(user)
    matches = match_store.list_user_matches(user["uid"])
    return add_cors_headers(jsonify({
        "user": user,
        "approved": True,
        "activeMatch": active_match,
        "matches": matches,
    })), 200


@app.route("/api/matches/new", methods=["POST", "OPTIONS"])
def api_new_match():
    """Archive l'ancienne rencontre active du JAE connecté et en crée une nouvelle unique."""
    if request.method == "OPTIONS":
        return add_cors_headers(app.make_response(("", 204)))

    user = match_store.verify_firebase_request(request)
    if not user:
        return add_cors_headers(jsonify({"error": "Authentication required"})), 401
    if not user.get("approved"):
        return add_cors_headers(jsonify({"error": "Compte en attente de validation par l'administrateur.", "code": "PENDING_APPROVAL"})), 403

    new_match = match_store.create_new_active_match(user)
    match_store.log_activity("match_created", user=user, match_id=new_match["matchId"])
    return add_cors_headers(jsonify({
        "status": "created",
        "matchId": new_match["matchId"],
        "match": new_match,
    })), 200


def _authorize_match_access(match_id):
    user = match_store.verify_firebase_request(request)
    if not user:
        return None, None, (jsonify({"error": "Authentication required"}), 401)
    if not user.get("approved"):
        return user, None, (jsonify({"error": "Compte en attente de validation par l'administrateur.", "code": "PENDING_APPROVAL"}), 403)
    match_doc = match_store.get_match(match_id)
    if not match_doc:
        return user, None, (jsonify({"error": "Rencontre introuvable"}), 404)
    if match_doc.get("ownerUid") and match_doc.get("ownerUid") != user["uid"] and not user.get("isAdmin"):
        return user, None, (jsonify({"error": "Accès interdit à cette rencontre"}), 403)
    return user, match_doc, None


def _require_admin():
    user = match_store.verify_firebase_request(request)
    if not user:
        return None, (jsonify({"error": "Authentication required"}), 401)
    if not user.get("isAdmin"):
        return user, (jsonify({"error": "Accès administrateur requis"}), 403)
    return user, None


@app.route("/admin", methods=["GET"])
def serve_admin_page():
    return render_template("admin.html", build_info=get_build_info())


@app.route("/mobile-auth", methods=["GET"])
def serve_mobile_auth():
    return render_template("oauth_bridge.html", target="mobile")


@app.route("/ext-auth", methods=["GET"])
def serve_ext_auth():
    return render_template("oauth_bridge.html", target="extension")


@app.route("/api/admin/overview", methods=["GET"])
def api_admin_overview():
    user, err = _require_admin()
    if err:
        return err
    users = match_store.list_all_users(limit=200)
    matches = match_store.list_all_matches(limit=200)
    logs = match_store.list_activity_logs(limit=150)
    stats = {
        "totalUsers": len(users),
        "activeMatches": sum(1 for m in matches if m.get("status") == "active"),
        "archivedMatches": sum(1 for m in matches if m.get("status") == "archived"),
        "totalEvents": len(logs),
        "errorEvents": sum(1 for l in logs if l.get("severity") == "error"),
    }
    return jsonify({
        "admin": user,
        "stats": stats,
        "users": users,
        "matches": matches,
        "logs": logs,
    }), 200


@app.route("/api/admin/matches/<match_id>/archive", methods=["POST"])
def api_admin_archive_match(match_id):
    user, err = _require_admin()
    if err:
        return err
    ok = match_store.archive_match_by_id(match_id)
    if not ok:
        return jsonify({"error": "Rencontre introuvable"}), 404
    match_store.log_activity("admin_archive_match", user=user, match_id=match_id)
    return jsonify({"status": "archived", "matchId": match_id}), 200


@app.route("/api/admin/matches/<match_id>", methods=["DELETE"])
def api_admin_delete_match(match_id):
    user, err = _require_admin()
    if err:
        return err
    ok = match_store.delete_match_recursive(match_id)
    if not ok:
        return jsonify({"error": "Rencontre introuvable"}), 404
    match_store.log_activity("admin_delete_match", user=user, match_id=match_id)
    return jsonify({"status": "deleted", "matchId": match_id}), 200


@app.route("/api/admin/users/<target_uid>", methods=["POST"])
def api_admin_update_user(target_uid):
    user, err = _require_admin()
    if err:
        return err
    payload = request.get_json(silent=True) or {}
    updated = match_store.update_user_access(
        target_uid,
        approved=payload.get("approved"),
        role=payload.get("role"),
    )
    if not updated:
        return jsonify({"error": "Utilisateur introuvable"}), 404
    match_store.log_activity(
        "admin_update_user",
        user=user,
        details={"targetUid": target_uid, "email": updated.get("email"), "approved": updated.get("approved"), "role": updated.get("role")},
    )
    return jsonify(updated), 200


@app.route("/api/admin/preapprove", methods=["POST"])
def api_admin_preapprove():
    user, err = _require_admin()
    if err:
        return err
    payload = request.get_json(silent=True) or {}
    email = (payload.get("email") or "").strip()
    role = payload.get("role") or "user"
    res = match_store.preapprove_email(email, role=role)
    if not res:
        return jsonify({"error": "Email invalide"}), 400
    match_store.log_activity("admin_preapprove_email", user=user, details=res)
    return jsonify(res), 200


@app.route("/api/admin/cleanup-archived", methods=["POST"])
def api_admin_cleanup_archived():
    user, err = _require_admin()
    if err:
        return err
    matches = match_store.list_all_matches(limit=500)
    deleted_ids = []
    for m in matches:
        if m.get("status") == "archived":
            if match_store.delete_match_recursive(m["matchId"]):
                deleted_ids.append(m["matchId"])
    match_store.log_activity(
        "admin_cleanup_archived",
        user=user,
        details={"deletedCount": len(deleted_ids)},
    )
    return jsonify({"status": "cleaned", "deletedCount": len(deleted_ids), "deletedIds": deleted_ids}), 200


@app.route("/api/matches/<match_id>/participants", methods=["GET"])
def api_match_participants(match_id):
    _, _, err = _authorize_match_access(match_id)
    if err:
        return err
    return jsonify(list(get_match_participants_data(match_id).values())), 200


@app.route("/api/matches/<match_id>/participants/<path:participant_id>", methods=["DELETE"])
def api_delete_match_participant(match_id, participant_id):
    user, _, err = _authorize_match_access(match_id)
    if err:
        return err
    deleted = match_store.delete_match_licence_by_participant(match_id, participant_id)
    match_store.log_activity(
        "participant_deleted",
        user=user,
        match_id=match_id,
        details={"participantId": participant_id, "deletedDocs": deleted},
    )
    return jsonify({"status": "deleted", "participantId": participant_id, "deletedDocs": deleted}), 200


@app.route("/api/matches/<match_id>/roster", methods=["GET", "POST", "OPTIONS"])
def api_match_roster(match_id):
    if request.method == "OPTIONS":
        return add_cors_headers(app.make_response(("", 204)))

    _, match_doc, err = _authorize_match_access(match_id)
    if err:
        return add_cors_headers(err[0]), err[1]

    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        roster = {
            "tenupUrl": (payload.get("tenupUrl") or "").strip(),
            "team1Name": (payload.get("team1Name") or "").strip(),
            "team1Players": payload.get("team1Players") or [],
            "team2Name": (payload.get("team2Name") or "").strip(),
            "team2Players": payload.get("team2Players") or [],
            "updatedAt": match_store.utc_now_iso(),
        }
        match_store.save_match_roster(match_id, roster)
        return add_cors_headers(jsonify({"matchId": match_id, **roster})), 200

    roster = match_doc.get("roster") or {}
    return add_cors_headers(jsonify({"matchId": match_id, **roster})), 200


@app.route("/api/matches/<match_id>/board-state", methods=["GET", "POST"])
def api_match_board_state(match_id):
    _, match_doc, err = _authorize_match_access(match_id)
    if err:
        return err

    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        state = {
            "team1Name": (payload.get("team1Name") or "").strip(),
            "team2Name": (payload.get("team2Name") or "").strip(),
            "tenupUrl": (payload.get("tenupUrl") or "").strip(),
            "assignments": payload.get("assignments") or {},
            "checked": payload.get("checked") or {},
            "updatedAt": match_store.utc_now_iso(),
        }
        match_store.save_match_board_state(match_id, state)
        match_store.log_activity(
            "board_updated",
            user=_,
            match_id=match_id,
            details={
                "team1Name": state["team1Name"],
                "team2Name": state["team2Name"],
                "assignedCount": len(state["assignments"]),
            },
        )
        return jsonify(state), 200

    return jsonify(match_doc.get("boardState") or {}), 200


@app.route("/api/tenup/roster", methods=["GET", "POST", "OPTIONS"])
def tenup_roster():
    """Lit ou enregistre directement (sans LLM) les compositions d'équipes Ten'Up parsées dans le DOM."""
    if request.method == "OPTIONS":
        return add_cors_headers(app.make_response(("", 204)))

    user = match_store.verify_firebase_request(request)

    if request.method == "POST":
        if not user and not is_authorized_request():
            return add_cors_headers(jsonify({"error": "Unauthorized"})), 401
        payload = request.get_json(silent=True) or {}
        roster = {
            "tenupUrl": (payload.get("tenupUrl") or "").strip(),
            "team1Name": (payload.get("team1Name") or "").strip(),
            "team1Players": payload.get("team1Players") or [],
            "team2Name": (payload.get("team2Name") or "").strip(),
            "team2Players": payload.get("team2Players") or [],
            "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        }
        try:
            if user:
                tenup_match_id = (
                    (payload.get("tenupMatchId") or "").strip()
                    or match_store.extract_tenup_match_id(roster["tenupUrl"])
                )
                create_new = bool(payload.get("newMatch"))
                if tenup_match_id:
                    active_match = match_store.create_new_active_match(user, preferred_match_id=tenup_match_id)
                elif create_new:
                    active_match = match_store.create_new_active_match(user)
                else:
                    active_match = match_store.get_or_create_active_match(user)
                match_id = active_match["matchId"]
                match_store.save_match_roster(match_id, roster)
                match_store.log_activity(
                    "roster_imported",
                    user=user,
                    match_id=match_id,
                    details={
                        "team1Name": roster["team1Name"],
                        "team1Count": len(roster["team1Players"]),
                        "team2Name": roster["team2Name"],
                        "team2Count": len(roster["team2Players"]),
                    },
                )
                return add_cors_headers(jsonify({"matchId": match_id, **roster})), 200

            bucket = storage_client.bucket(RESULTS_BUCKET_NAME)
            bucket.blob("ROSTER_CURRENT.json").upload_from_string(
                json.dumps(roster, indent=2, ensure_ascii=False),
                content_type="application/json",
            )
            return add_cors_headers(jsonify(roster)), 200
        except Exception as e:
            logging.error(f"Erreur sauvegarde roster Ten'Up : {e}")
            return add_cors_headers(jsonify({"error": str(e)})), 500

    if user:
        active_match = match_store.get_or_create_active_match(user)
        return add_cors_headers(jsonify({"matchId": active_match["matchId"], **(active_match.get("roster") or {})})), 200

    try:
        bucket = storage_client.bucket(RESULTS_BUCKET_NAME)
        roster_blob = bucket.blob("ROSTER_CURRENT.json")
        if not roster_blob.exists():
            return add_cors_headers(jsonify({})), 200
        return add_cors_headers(jsonify(json.loads(roster_blob.download_as_string()))), 200
    except Exception as e:
        logging.error(f"Erreur lecture ROSTER_CURRENT.json : {e}")
        return add_cors_headers(jsonify({})), 200


@app.route("/api/board-state", methods=["GET", "POST"])
def board_state():
    """Synchronise l'état du tableau (affectations glisser-déposer, titres, URL Ten'Up, cases cochées) entre machines."""
    bucket = storage_client.bucket(RESULTS_BUCKET_NAME)
    state_blob = bucket.blob("BOARD_STATE.json")

    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        state = {
            "team1Name": (payload.get("team1Name") or "").strip(),
            "team2Name": (payload.get("team2Name") or "").strip(),
            "tenupUrl": (payload.get("tenupUrl") or "").strip(),
            "assignments": payload.get("assignments") or {},
            "checked": payload.get("checked") or {},
            "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        }
        try:
            state_blob.upload_from_string(
                json.dumps(state, indent=2, ensure_ascii=False),
                content_type="application/json",
            )
            return jsonify(state), 200
        except Exception as e:
            logging.error(f"Erreur sauvegarde BOARD_STATE.json : {e}")
            return jsonify({"error": str(e)}), 500

    try:
        if not state_blob.exists():
            return jsonify({}), 200
        return jsonify(json.loads(state_blob.download_as_string())), 200
    except Exception as e:
        logging.error(f"Erreur lecture BOARD_STATE.json : {e}")
        return jsonify({}), 200


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


@app.route("/demo", methods=["GET"])
def serve_demo_page():
    build_info = get_build_info()
    return render_template(
        "index.html",
        participants=[],
        debug=False,
        demo=True,
        match_id="DEMO-INTERACTIVE",
        build_info=build_info,
    )


@app.route("/", methods=["GET"])
@app.route("/m/<match_id>", methods=["GET"])
def serve_page(match_id=None):
    debug_mode = request.args.get("debug", "false").lower() == "true"
    build_info = get_build_info()
    return render_template(
        "index.html",
        participants=[],
        debug=debug_mode,
        demo=False,
        match_id=match_id or "",
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
