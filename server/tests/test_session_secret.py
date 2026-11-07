"""GIS_SESSION_SECRET 沒設（或沿用範例佔位字串）時，session 不能用公開字串簽章。

repo 是公開的：只要伺服器用了 repo 裡寫死的預設值，任何人都能自己簽一個
{"uid": N, "sv": 0} 的 cookie，冒充任何使用者讀寫他的專案。
"""
import pytest
from itsdangerous import URLSafeTimedSerializer

from server import auth

from .conftest import another_client, login

PUBLIC_STRINGS = [
    None,  # 完全沒設
    "",
    "dev-insecure-secret-change-me",  # 舊版 auth.py 的預設值
    "replace-with-a-long-random-string",  # packaging/env.local.bat.example 的佔位字串
    "change-me-to-a-long-random-string",  # server/.env.example 的佔位字串
]


@pytest.mark.parametrize("secret", PUBLIC_STRINGS)
def test_cannot_forge_session_with_public_secret(make_client, secret):
    client = make_client(GIS_SESSION_SECRET=secret)
    victim = login(client, sub="1000001", email="victim@example.com")
    pid = client.post("/api/projects", json={"name": "機密"}).json()["id"]

    attacker = another_client(client)
    for guess in PUBLIC_STRINGS[1:]:
        forged = URLSafeTimedSerializer(guess, salt="gis-session").dumps({"uid": victim["id"], "sv": 0})
        attacker.cookies.set(auth.COOKIE_NAME, forged)
        assert attacker.get("/api/me").status_code == 401
        assert attacker.get(f"/api/projects/{pid}").status_code == 401


# 長度 < 32 的金鑰（含 31 字元的邊界）離線爆破成本低，視同不合格：改用隨機金鑰。
SHORT_SECRETS = ["a", "short-secret-0123456789", "x" * 31]


@pytest.mark.parametrize("secret", SHORT_SECRETS)
def test_short_secret_is_rejected_and_cannot_forge(make_client, secret):
    assert len(secret) < 32
    client = make_client(GIS_SESSION_SECRET=secret)
    victim = login(client, sub="1000002", email="victim2@example.com")
    attacker = another_client(client)
    # 攻擊者若猜中（或爆破出）這把短金鑰，就能簽出任何 uid 的 cookie
    forged = URLSafeTimedSerializer(secret, salt="gis-session").dumps({"uid": victim["id"], "sv": 0})
    attacker.cookies.set(auth.COOKIE_NAME, forged)
    assert attacker.get("/api/me").status_code == 401


def test_short_secret_logs_warning(make_client, caplog):
    with caplog.at_level("WARNING"):
        make_client(GIS_SESSION_SECRET="x" * 31)
    assert any("GIS_SESSION_SECRET" in r.getMessage() for r in caplog.records)


def test_secret_of_exactly_32_chars_is_accepted(make_client):
    secret = "k" * 32
    client = make_client(GIS_SESSION_SECRET=secret)
    user = login(client)
    other = another_client(client)
    other.cookies.set(
        auth.COOKIE_NAME,
        URLSafeTimedSerializer(secret, salt="gis-session").dumps({"uid": user["id"], "sv": 0}),
    )
    assert other.get("/api/me").status_code == 200


def test_configured_secret_is_used(make_client):
    secret = "a-properly-configured-secret-value-for-tests-only-0123456789"
    client = make_client(GIS_SESSION_SECRET=secret)
    user = login(client)
    other = another_client(client)
    other.cookies.set(
        auth.COOKIE_NAME,
        URLSafeTimedSerializer(secret, salt="gis-session").dumps({"uid": user["id"], "sv": 0}),
    )
    assert other.get("/api/me").status_code == 200
