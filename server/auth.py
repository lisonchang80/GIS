"""Google ID-token verification + stateless signed session cookie.

We use the lightest OAuth flow: the frontend's "Sign in with Google" button
hands us a Google-signed ID token (JWT). We verify its signature / audience /
issuer / expiry, then issue our OWN signed session token (itsdangerous) stored
in an httpOnly cookie. No client secret and no redirect dance are needed because
we never call Google APIs on the user's behalf.
"""
import os

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

SESSION_SECRET = os.environ.get("GIS_SESSION_SECRET", "dev-insecure-secret-change-me")
GOOGLE_CLIENT_ID = os.environ.get("GIS_GOOGLE_CLIENT_ID", "")

COOKIE_NAME = "gis_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 30  # 30 days

_serializer = URLSafeTimedSerializer(SESSION_SECRET, salt="gis-session")


def make_session(uid: int) -> str:
    return _serializer.dumps({"uid": uid})


def read_session(token: str):
    try:
        data = _serializer.loads(token, max_age=SESSION_MAX_AGE)
        return data.get("uid")
    except (BadSignature, SignatureExpired):
        return None


def verify_google_credential(credential: str) -> dict:
    """Return the verified token claims (sub / email / name / picture)."""
    if not GOOGLE_CLIENT_ID:
        raise ValueError("GIS_GOOGLE_CLIENT_ID not configured")
    # Imported lazily so the dev-login path works even before google-auth is set up.
    from google.auth.transport import requests as g_requests
    from google.oauth2 import id_token as google_id_token

    info = google_id_token.verify_oauth2_token(
        credential, g_requests.Request(), GOOGLE_CLIENT_ID
    )
    if info.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
        raise ValueError("invalid issuer")
    return info
