"""Google ID token 驗證與 session cookie 的基本性質。"""
import time

from itsdangerous import URLSafeTimedSerializer

from server import auth

from .conftest import TEST_SESSION_SECRET, make_id_token


def _post(client, token):
    return client.post("/api/auth/google", json={"credential": token})


def test_valid_token_logs_in_and_sets_cookie(client):
    r = _post(client, make_id_token())
    assert r.status_code == 200
    assert r.json()["user"]["email"] == "alice@example.com"
    assert client.get("/api/me").json()["user"]["email"] == "alice@example.com"


def test_rejects_forged_signature(client):
    assert _post(client, make_id_token(signed_by_google=False)).status_code == 401


def test_rejects_wrong_audience(client):
    token = make_id_token(aud="someone-elses-client.apps.googleusercontent.com")
    assert _post(client, token).status_code == 401


def test_rejects_wrong_issuer(client):
    assert _post(client, make_id_token(iss="https://evil.example.com")).status_code == 401


def test_rejects_expired_token(client):
    assert _post(client, make_id_token(exp_delta=-3600)).status_code == 401


def test_rejects_garbage(client):
    assert _post(client, "not-a-jwt").status_code == 401
    assert client.get("/api/me").status_code == 401


def test_session_cookie_flags(client):
    r = _post(client, make_id_token())
    cookie = r.headers["set-cookie"]
    lower = cookie.lower()
    assert "httponly" in lower
    assert "secure" in lower
    assert "samesite=lax" in lower
    assert "path=/" in lower
    assert "domain=" not in lower  # host-only，不分享給其他子網域
    assert f"max-age={auth.SESSION_MAX_AGE}" in lower


def test_tampered_or_expired_session_is_rejected(client, monkeypatch):
    _post(client, make_id_token())
    good = client.cookies.get(auth.COOKIE_NAME)
    client.cookies.clear()

    client.cookies.set(auth.COOKIE_NAME, good[:-2] + ("AA" if not good.endswith("AA") else "BB"))
    assert client.get("/api/me").status_code == 401

    # 簽章正確但已超過 SESSION_MAX_AGE
    old = URLSafeTimedSerializer(TEST_SESSION_SECRET, salt="gis-session")
    real_time = time.time
    monkeypatch.setattr(time, "time", lambda: real_time() - auth.SESSION_MAX_AGE - 60)
    stale = old.dumps({"uid": 1})
    monkeypatch.setattr(time, "time", real_time)
    client.cookies.clear()
    client.cookies.set(auth.COOKIE_NAME, stale)
    assert client.get("/api/me").status_code == 401


def test_junk_credential_rejected_without_fetching_certs(client, monkeypatch):
    from google.oauth2 import id_token as google_id_token

    calls = []
    monkeypatch.setattr(google_id_token, "_fetch_certs", lambda req, url: calls.append(url) or {})
    for junk in ("x", "a.b", "a.b.c.d", "a." + "b" * 5000 + ".c", "a.b$.c"):
        assert _post(client, junk).status_code == 401
    assert calls == []


def test_google_certs_response_is_cached(monkeypatch):
    from google.auth.transport import requests as g_requests

    calls = []

    class FakeResp:
        status = 200
        headers = {"Cache-Control": "public, max-age=19000, must-revalidate"}
        data = b"{}"

    class FakeRequest:
        def __call__(self, url, method="GET", **kwargs):
            calls.append(url)
            return FakeResp()

    monkeypatch.setattr(g_requests, "Request", FakeRequest)
    monkeypatch.setattr(auth, "_certs_cache", {})
    url = "https://www.googleapis.com/oauth2/v1/certs"
    first = auth._cached_request(url, method="GET")
    second = auth._cached_request(url, method="GET")
    assert first is second
    assert calls == [url]
    assert auth._certs_ttl(FakeResp.headers) == 19000
