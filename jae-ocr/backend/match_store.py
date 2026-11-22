import datetime as dt
import logging
import os
import re
import uuid

import firebase_admin
from firebase_admin import auth as fb_auth
from firebase_admin import firestore

GCP_PROJECT = os.getenv("GCP_PROJECT", os.getenv("GOOGLE_CLOUD_PROJECT", "alexismp-runner"))
DEFAULT_ADMIN_EMAIL = "alexis.mp@gmail.com"
ADMIN_EMAILS = {
    e.strip().lower()
    for e in os.getenv("ADMIN_EMAILS", DEFAULT_ADMIN_EMAIL).split(",")
    if e.strip()
} | {DEFAULT_ADMIN_EMAIL}

if not firebase_admin._apps:
    firebase_admin.initialize_app(options={"projectId": GCP_PROJECT})

db = firestore.client()

MATCH_PREFIX_RE = re.compile(r"^m_([a-zA-Z0-9_-]+)/(.+)$")


def normalize_email(email):
    return (email or "").strip().lower()


def is_default_admin_email(email):
    return normalize_email(email) in ADMIN_EMAILS


def ensure_user_profile(user):
    """Crée ou met à jour `users/{uid}` dans Firestore et résout `approved` + `isAdmin` dynamiquement."""
    uid = user["uid"]
    email = normalize_email(user.get("email"))
    now = utc_now_iso()
    user_ref = db.collection("users").document(uid)
    snap = user_ref.get()
    is_bootstrap_admin = is_default_admin_email(email)

    if snap.exists:
        data = snap.to_dict() or {}
        role = "admin" if (is_bootstrap_admin or data.get("role") == "admin") else "user"
        approved = True if (is_bootstrap_admin or role == "admin" or data.get("approved") is True) else False
        # Vérifier aussi la pré-approbation par email si pas encore approuvé
        if not approved and email:
            pre_snap = db.collection("approved_emails").document(sanitize_doc_id(email)).get()
            if pre_snap.exists:
                pre = pre_snap.to_dict() or {}
                approved = True
                if pre.get("role") == "admin":
                    role = "admin"
                user_ref.update({"approved": True, "role": role, "updatedAt": now})
        if is_bootstrap_admin and (data.get("role") != "admin" or data.get("approved") is not True):
            user_ref.update({"approved": True, "role": "admin", "updatedAt": now})
        return {
            **user,
            "email": email or user.get("email") or "",
            "role": role,
            "isAdmin": role == "admin",
            "approved": approved,
            "activeMatchId": data.get("activeMatchId") or "",
        }

    # Nouvel utilisateur (onboarding)
    role = "admin" if is_bootstrap_admin else "user"
    approved = is_bootstrap_admin
    if not approved and email:
        pre_snap = db.collection("approved_emails").document(sanitize_doc_id(email)).get()
        if pre_snap.exists:
            pre = pre_snap.to_dict() or {}
            approved = True
            if pre.get("role") == "admin":
                role = "admin"

    new_profile = {
        "uid": uid,
        "email": email,
        "displayName": user.get("name") or email,
        "role": role,
        "approved": approved,
        "activeMatchId": "",
        "createdAt": now,
        "updatedAt": now,
    }
    user_ref.set(new_profile)
    log_activity(
        "user_registered",
        user={"uid": uid, "email": email},
        details={"approved": approved, "role": role},
        severity="info",
    )
    return {
        **user,
        "email": email,
        "role": role,
        "isAdmin": role == "admin",
        "approved": approved,
        "activeMatchId": "",
    }


def is_admin_user(user):
    if not user:
        return False
    return bool(user.get("isAdmin")) or is_default_admin_email(user.get("email"))


def utc_now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def parse_match_id_from_object_name(object_name):
    """Extrait (match_id, bare_name) d'un nom d'objet GCS préfixé `m_<match_id>/<file>`."""
    if not object_name:
        return None, object_name
    m = MATCH_PREFIX_RE.match(object_name)
    if m:
        return m.group(1), m.group(2)
    return None, object_name


def sanitize_doc_id(raw_value):
    return re.sub(r"[^a-zA-Z0-9_.-]", "_", str(raw_value or "unknown"))[:120]


def verify_firebase_request(req):
    """Vérifie le jeton Firebase ID Token (`Authorization: Bearer <token>`). Retourne dict user ou None."""
    auth_header = req.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    token = auth_header[7:].strip()
    if not token:
        return None
    try:
        decoded = fb_auth.verify_id_token(token)
        email = (decoded.get("email") or "").strip()
        base_user = {
            "uid": decoded["uid"],
            "email": email,
            "name": decoded.get("name") or email or decoded["uid"],
        }
        return ensure_user_profile(base_user)
    except Exception as e:
        logging.warning(f"Échec vérification Firebase ID token : {e}")
        return None


def generate_match_id():
    today = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d")
    return f"{today}-{uuid.uuid4().hex[:8]}"


def _new_match_doc(match_id, user):
    now = utc_now_iso()
    return {
        "matchId": match_id,
        "ownerUid": user["uid"],
        "ownerEmail": user.get("email") or "",
        "status": "active",
        "createdAt": now,
        "updatedAt": now,
        "tenupUrl": "",
        "team1Name": "Equipe 1",
        "team2Name": "Equipe 2",
        "roster": {},
        "boardState": {},
    }


def get_or_create_active_match(user):
    """Retourne la rencontre active unique de l'utilisateur (ou en crée une nouvelle)."""
    uid = user["uid"]
    user_ref = db.collection("users").document(uid)
    user_snap = user_ref.get()
    if user_snap.exists:
        active_id = (user_snap.to_dict() or {}).get("activeMatchId")
        if active_id:
            match_snap = db.collection("matches").document(active_id).get()
            if match_snap.exists:
                data = match_snap.to_dict() or {}
                if data.get("status") == "active" and data.get("ownerUid") == uid:
                    return data

    return create_new_active_match(user)


def create_new_active_match(user):
    """Archive l'éventuelle rencontre active de l'utilisateur et en crée une nouvelle unique."""
    uid = user["uid"]
    now = utc_now_iso()
    user_ref = db.collection("users").document(uid)
    user_snap = user_ref.get()

    # 1. Archiver l'ancienne rencontre active (garantit 1 seule rencontre active par JAE)
    if user_snap.exists:
        old_id = (user_snap.to_dict() or {}).get("activeMatchId")
        if old_id:
            old_ref = db.collection("matches").document(old_id)
            if old_ref.get().exists:
                old_ref.update({"status": "archived", "archivedAt": now, "updatedAt": now})

    # Par sécurité, archiver toute autre rencontre active résiduelle de cet utilisateur
    for doc in db.collection("matches").where("ownerUid", "==", uid).where("status", "==", "active").stream():
        doc.reference.update({"status": "archived", "archivedAt": now, "updatedAt": now})

    # 2. Créer la nouvelle rencontre active
    new_id = generate_match_id()
    match_data = _new_match_doc(new_id, user)
    db.collection("matches").document(new_id).set(match_data)
    user_ref.set(
        {
            "uid": uid,
            "email": user.get("email") or "",
            "displayName": user.get("name") or "",
            "activeMatchId": new_id,
            "updatedAt": now,
        },
        merge=True,
    )
    logging.info(f"Nouvelle rencontre active créée pour {user.get('email')}: {new_id}")
    return match_data


def get_match(match_id):
    if not match_id:
        return None
    snap = db.collection("matches").document(match_id).get()
    if not snap.exists:
        return None
    return snap.to_dict()


def list_user_matches(uid, limit=20):
    docs = (
        db.collection("matches")
        .where("ownerUid", "==", uid)
        .stream()
    )
    items = []
    for doc in docs:
        d = doc.to_dict() or {}
        items.append({
            "matchId": d.get("matchId") or doc.id,
            "status": d.get("status") or "active",
            "team1Name": d.get("team1Name") or "Equipe 1",
            "team2Name": d.get("team2Name") or "Equipe 2",
            "createdAt": d.get("createdAt") or "",
            "updatedAt": d.get("updatedAt") or "",
        })
    items.sort(key=lambda x: x.get("updatedAt") or "", reverse=True)
    return items[:limit]


def save_match_roster(match_id, roster):
    now = utc_now_iso()
    update_fields = {
        "roster": roster,
        "updatedAt": now,
    }
    if roster.get("team1Name"):
        update_fields["team1Name"] = roster["team1Name"]
    if roster.get("team2Name"):
        update_fields["team2Name"] = roster["team2Name"]
    if roster.get("tenupUrl"):
        update_fields["tenupUrl"] = roster["tenupUrl"]
    db.collection("matches").document(match_id).set(update_fields, merge=True)


def save_match_board_state(match_id, state):
    now = utc_now_iso()
    update_fields = {
        "boardState": state,
        "updatedAt": now,
    }
    if state.get("team1Name"):
        update_fields["team1Name"] = state["team1Name"]
    if state.get("team2Name"):
        update_fields["team2Name"] = state["team2Name"]
    if "tenupUrl" in state:
        update_fields["tenupUrl"] = state["tenupUrl"]
    db.collection("matches").document(match_id).set(update_fields, merge=True)


def save_match_licence(match_id, doc_id, record):
    now = utc_now_iso()
    db.collection("matches").document(match_id).collection("licences").document(sanitize_doc_id(doc_id)).set(record)
    db.collection("matches").document(match_id).set({"updatedAt": now}, merge=True)


def save_match_identity(match_id, doc_id, record):
    now = utc_now_iso()
    db.collection("matches").document(match_id).collection("identities").document(sanitize_doc_id(doc_id)).set(record)
    db.collection("matches").document(match_id).set({"updatedAt": now}, merge=True)


def save_match_scan_status(match_id, object_name, payload):
    doc_id = sanitize_doc_id(object_name)
    data = {"file_name": object_name, "updated_at": utc_now_iso(), **payload}
    db.collection("matches").document(match_id).collection("scan_status").document(doc_id).set(data)


def get_match_scan_status(match_id, object_name):
    doc_id = sanitize_doc_id(object_name)
    snap = db.collection("matches").document(match_id).collection("scan_status").document(doc_id).get()
    if not snap.exists:
        return None
    return snap.to_dict()


def load_match_records(match_id):
    """Retourne (match_doc, licences_list, identities_list)."""
    match_ref = db.collection("matches").document(match_id)
    snap = match_ref.get()
    if not snap.exists:
        return None, [], []
    match_doc = snap.to_dict() or {}
    licences = [(d.id, d.to_dict() or {}) for d in match_ref.collection("licences").stream()]
    identities = [(d.id, d.to_dict() or {}) for d in match_ref.collection("identities").stream()]
    return match_doc, licences, identities


def log_activity(event_type, user=None, match_id=None, details=None, severity="info"):
    """Enregistre un événement d'audit dans Firestore `activity_logs` pour la console admin."""
    try:
        doc_id = f"{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d%H%M%S%f')}_{uuid.uuid4().hex[:6]}"
        db.collection("activity_logs").document(doc_id).set({
            "timestamp": utc_now_iso(),
            "eventType": event_type,
            "severity": severity,
            "uid": (user or {}).get("uid") or "system",
            "email": (user or {}).get("email") or "system",
            "matchId": match_id or "",
            "details": details or {},
        })
    except Exception as e:
        logging.warning(f"Impossible d'enregistrer activity_log ({event_type}) : {e}")


def list_all_users(limit=100):
    items = []
    for doc in db.collection("users").stream():
        d = doc.to_dict() or {}
        email = normalize_email(d.get("email"))
        role = "admin" if (is_default_admin_email(email) or d.get("role") == "admin") else "user"
        approved = True if (is_default_admin_email(email) or role == "admin" or d.get("approved") is True) else False
        items.append({
            "uid": d.get("uid") or doc.id,
            "email": email,
            "displayName": d.get("displayName") or "",
            "role": role,
            "approved": approved,
            "isDefaultAdmin": is_default_admin_email(email),
            "activeMatchId": d.get("activeMatchId") or "",
            "createdAt": d.get("createdAt") or "",
            "updatedAt": d.get("updatedAt") or "",
        })
    items.sort(key=lambda x: (not x["approved"], x.get("updatedAt") or ""), reverse=False)
    return items[:limit]


def update_user_access(target_uid, approved=None, role=None):
    ref = db.collection("users").document(target_uid)
    snap = ref.get()
    if not snap.exists:
        return None
    data = snap.to_dict() or {}
    email = normalize_email(data.get("email"))
    if is_default_admin_email(email):
        return {**data, "approved": True, "role": "admin"}
    updates = {"updatedAt": utc_now_iso()}
    if approved is not None:
        updates["approved"] = bool(approved)
    if role in ("admin", "user"):
        updates["role"] = role
        if role == "admin":
            updates["approved"] = True
    ref.update(updates)
    return {**data, **updates}


def preapprove_email(email, role="user"):
    norm = normalize_email(email)
    if not norm:
        return None
    doc_id = sanitize_doc_id(norm)
    payload = {
        "email": norm,
        "role": "admin" if role == "admin" else "user",
        "updatedAt": utc_now_iso(),
    }
    db.collection("approved_emails").document(doc_id).set(payload)
    # Mettre aussi à jour le compte existant si déjà inscrit
    for doc in db.collection("users").where("email", "==", norm).stream():
        doc.reference.update({"approved": True, "role": payload["role"], "updatedAt": payload["updatedAt"]})
    return payload


def list_all_matches(limit=100):
    items = []
    for doc in db.collection("matches").stream():
        d = doc.to_dict() or {}
        mid = d.get("matchId") or doc.id
        lic_count = sum(1 for _ in doc.reference.collection("licences").stream())
        pid_count = sum(1 for _ in doc.reference.collection("identities").stream())
        roster = d.get("roster") or {}
        roster_count = len(roster.get("team1Players") or []) + len(roster.get("team2Players") or [])
        items.append({
            "matchId": mid,
            "ownerUid": d.get("ownerUid") or "",
            "ownerEmail": d.get("ownerEmail") or "",
            "status": d.get("status") or "active",
            "team1Name": d.get("team1Name") or "Equipe 1",
            "team2Name": d.get("team2Name") or "Equipe 2",
            "tenupUrl": d.get("tenupUrl") or "",
            "rosterCount": roster_count,
            "licencesCount": lic_count,
            "identitiesCount": pid_count,
            "createdAt": d.get("createdAt") or "",
            "updatedAt": d.get("updatedAt") or "",
        })
    items.sort(key=lambda x: x.get("updatedAt") or "", reverse=True)
    return items[:limit]


def list_activity_logs(limit=100):
    docs = (
        db.collection("activity_logs")
        .order_by("timestamp", direction=firestore.Query.DESCENDING)
        .limit(limit)
        .stream()
    )
    return [d.to_dict() or {} for d in docs]


def archive_match_by_id(match_id):
    ref = db.collection("matches").document(match_id)
    snap = ref.get()
    if not snap.exists:
        return False
    now = utc_now_iso()
    ref.update({"status": "archived", "archivedAt": now, "updatedAt": now})
    return True


def delete_match_recursive(match_id):
    ref = db.collection("matches").document(match_id)
    snap = ref.get()
    if not snap.exists:
        return False
    data = snap.to_dict() or {}
    for sub in ("licences", "identities", "scan_status"):
        for doc in ref.collection(sub).stream():
            doc.reference.delete()
    ref.delete()
    # Si c'était la rencontre active du propriétaire, nettoyer activeMatchId
    owner_uid = data.get("ownerUid")
    if owner_uid:
        user_ref = db.collection("users").document(owner_uid)
        u_snap = user_ref.get()
        if u_snap.exists and (u_snap.to_dict() or {}).get("activeMatchId") == match_id:
            user_ref.update({"activeMatchId": "", "updatedAt": utc_now_iso()})
    return True

