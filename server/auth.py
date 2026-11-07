"""Google ID-token verification + signed session cookie (revocable via users.session_version).

We use the lightest OAuth flow: the frontend's "Sign in with Google" button
hands us a Google-signed ID token (JWT). We verify its signature / audience /
issuer / expiry, then issue our OWN signed session token (itsdangerous) stored
in an httpOnly cookie. No client secret and no redirect dance are needed because
we never call Google APIs on the user's behalf.
"""
import logging
import os
import re
import secrets
import threading
import time

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

log = logging.getLogger(__name__)

# Strings that are public (this repo / the env.local.bat example) and therefore
# must never be used to sign sessions: anyone could forge a cookie for any uid.
_PUBLIC_SECRETS = {
    "",
    "dev-insecure-secret-change-me",
    "replace-with-a-long-random-string",
    "change-me-to-a-long-random-string",  # server/.env.example
}

# A short secret is brute-forceable offline from any one captured cookie, so it is
# as good as a public one.
MIN_SECRET_LEN = 32

SESSION_SECRET = os.environ.get("GIS_SESSION_SECRET", "").strip()
if SESSION_SECRET in _PUBLIC_SECRETS or len(SESSION_SECRET) < MIN_SECRET_LEN:
    # Fail safe: a random per-process secret. Sessions stop surviving a restart
    # (everyone re-logs in), but nobody can forge one.
    log.warning(
        "GIS_SESSION_SECRET is unset, a placeholder, or shorter than %d characters; "
        "using a random secret (sessions reset on restart)",
        MIN_SECRET_LEN,
    )
    SESSION_SECRET = secrets.token_urlsafe(48)
GOOGLE_CLIENT_ID = os.environ.get("GIS_GOOGLE_CLIENT_ID", "")

COOKIE_SECURE = os.environ.get("GIS_COOKIE_SECURE", "1") == "1"
# __Host- prefix: browsers only accept it with Secure + Path=/ and no Domain, so a
# page on a sibling *.tinghaochang.com can't plant (toss) a session cookie that we
# would pick up. Plain-http dev can't use the prefix.
COOKIE_NAME = "__Host-gis_session" if COOKIE_SECURE else "gis_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 30  # 30 days

_serializer = URLSafeTimedSerializer(SESSION_SECRET, salt="gis-session")


def make_session(uid: int, session_version: int) -> str:
    # sv = users.session_version at login. Logout bumps it server-side, so every
    # cookie issued before (including a copied one) stops working.
    return _serializer.dumps({"uid": uid, "sv": session_version})


def read_session(token: str):
    """Signature + expiry check only -> (uid, session_version), or None.

    The caller must still compare session_version with the stored one
    (routes.session_uid). Old-format cookies without "sv" are rejected.
    """
    try:
        data = _serializer.loads(token, max_age=SESSION_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None
    if not isinstance(data, dict):
        return None
    uid, sv = data.get("uid"), data.get("sv")
    if type(uid) is not int or type(sv) is not int:
        return None
    return uid, sv


# Google's signing certs change rarely and are served with Cache-Control max-age;
# google-auth itself re-downloads them on EVERY verify, so cache them here.
_CERTS_TTL_DEFAULT = 3600
_CERTS_TTL_MAX = 24 * 3600
_certs_lock = threading.Lock()
_certs_cache: dict = {}  # url -> (expires_at monotonic, response)
_MAX_AGE_RE = re.compile(r"max-age=(\d+)")
# A Google ID token is a compact JWS: three base64url segments, ~1-2 KB.
_JWT_RE = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
_MAX_CREDENTIAL_LEN = 4096


def _certs_ttl(headers) -> int:
    m = _MAX_AGE_RE.search((headers or {}).get("Cache-Control", "") or "")
    if not m:
        return _CERTS_TTL_DEFAULT
    return min(int(m.group(1)), _CERTS_TTL_MAX)


def _cached_request(url, method="GET", **kwargs):
    """google-auth transport Request that caches successful GETs (the certs URL)."""
    from google.auth.transport import requests as g_requests

    if method != "GET":
        return g_requests.Request()(url, method=method, **kwargs)
    with _certs_lock:
        hit = _certs_cache.get(url)
        if hit and hit[0] > time.monotonic():
            return hit[1]
    resp = g_requests.Request()(url, method=method, **kwargs)
    if resp.status == 200:
        with _certs_lock:
            _certs_cache[url] = (time.monotonic() + _certs_ttl(resp.headers), resp)
    return resp


def verify_google_credential(credential: str) -> dict:
    """Return the verified token claims (sub / email / name / picture)."""
    if not GOOGLE_CLIENT_ID:
        raise ValueError("GIS_GOOGLE_CLIENT_ID not configured")
    # Cheap shape check first so junk never triggers any work toward Google.
    if len(credential) > _MAX_CREDENTIAL_LEN or not _JWT_RE.fullmatch(credential):
        raise ValueError("malformed credential")
    # Imported lazily so the dev-login path works even before google-auth is set up.
    from google.oauth2 import id_token as google_id_token

    # clock_skew_in_seconds tolerance is REQUIRED: google-auth defaults to 0, so if
    # this server's clock lags Google's issuing clock by even ~1s, a freshly-minted
    # token's `iat`/`nbf` is "in the future" and verify raises "Token used too early".
    # That makes logins fail intermittently near second boundaries. Allow a small skew.
    info = google_id_token.verify_oauth2_token(
        credential, _cached_request, GOOGLE_CLIENT_ID, clock_skew_in_seconds=30
    )
    if info.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
        raise ValueError("invalid issuer")
    # The email is stored and shown as the user's identity; only trust it if
    # Google says the account actually owns it.
    if info.get("email_verified") not in (True, "true"):
        raise ValueError("email not verified")
    return info
