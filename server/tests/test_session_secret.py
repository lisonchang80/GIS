"""GIS_SESSION_SECRET 沒設（或沿用範例佔位字串）時，session 不能用公開字串簽章。

repo 是公開的：只要伺服器用了 repo 裡寫死的預設值，任何人都能自己簽一個
{"uid": N} 的 cookie，冒充任何使用者讀寫他的專案。
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
]


@pytest.mark.parametrize("secret", PUBLIC_STRINGS)
def test_cannot_forge_session_with_public_secret(make_client, secret):
    client = make_client(GIS_SESSION_SECRET=secret)
    victim = login(client, sub="1000001", email="victim@example.com")
    pid = client.post("/api/projects", json={"name": "機密"}).json()["id"]

    attacker = another_client(client)
    for guess in PUBLIC_STRINGS[1:]:
        forged = URLSafeTimedSerializer(guess, salt="gis-session").dumps({"uid": victim["id"]})
        attacker.cookies.set(auth.COOKIE_NAME, forged)
        assert attacker.get("/api/me").status_code == 401
        assert attacker.get(f"/api/projects/{pid}").status_code == 401


def test_configured_secret_is_used(make_client):
    secret = "a-properly-configured-secret-value-for-tests-only-0123456789"
    client = make_client(GIS_SESSION_SECRET=secret)
    user = login(client)
    other = another_client(client)
    other.cookies.set(
        auth.COOKIE_NAME,
        URLSafeTimedSerializer(secret, salt="gis-session").dumps({"uid": user["id"]}),
    )
    assert other.get("/api/me").status_code == 200
