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
