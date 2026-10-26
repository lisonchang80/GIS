"""Google ID-token verification + stateless signed session cookie.

We use the lightest OAuth flow: the frontend's "Sign in with Google" button
hands us a Google-signed ID token (JWT). We verify its signature / audience /
issuer / expiry, then issue our OWN signed session token (itsdangerous) stored
in an httpOnly cookie. No client secret and no redirect dance are needed because
we never call Google APIs on the user's behalf.
"""
import logging
import os
import secrets

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

log = logging.getLogger(__name__)

# Strings that are public (this repo / the env.local.bat example) and therefore
# must never be used to sign sessions: anyone could forge a cookie for any uid.
_PUBLIC_SECRETS = {"", "dev-insecure-secret-change-me", "replace-with-a-long-random-string"}

SESSION_SECRET = os.environ.get("GIS_SESSION_SECRET", "").strip()
if SESSION_SECRET in _PUBLIC_SECRETS:
    # Fail safe: a random per-process secret. Sessions stop surviving a restart
    # (everyone re-logs in), but nobody can forge one.
    log.warning("GIS_SESSION_SECRET is unset or a placeholder; using a random secret (sessions reset on restart)")
    SESSION_SECRET = secrets.token_urlsafe(48)
GOOGLE_CLIENT_ID = os.environ.get("GIS_GOOGLE_CLIENT_ID", "")

COOKIE_SECURE = os.environ.get("GIS_COOKIE_SECURE", "1") == "1"
# __Host- prefix: browsers only accept it with Secure + Path=/ and no Domain, so a
# page on a sibling *.tinghaochang.com can't plant (toss) a session cookie that we
# would pick up. Plain-http dev can't use the prefix.
COOKIE_NAME = "__Host-gis_session" if COOKIE_SECURE else "gis_session"
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

    # clock_skew_in_seconds tolerance is REQUIRED: google-auth defaults to 0, so if
    # this server's clock lags Google's issuing clock by even ~1s, a freshly-minted
    # token's `iat`/`nbf` is "in the future" and verify raises "Token used too early".
    # That makes logins fail intermittently near second boundaries. Allow a small skew.
    info = google_id_token.verify_oauth2_token(
        credential, g_requests.Request(), GOOGLE_CLIENT_ID, clock_skew_in_seconds=30
    )
    if info.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
        raise ValueError("invalid issuer")
    return info
