"""pytest 共用設定：每個測試一個暫存 SQLite、不連外網、用自簽金鑰模擬 Google ID token。

後端模組（auth / routes / main）在 import 時讀環境變數，所以 `make_client(**env)`
會先設好環境變數與暫存 DB 路徑，再依序 reload 這三個模組，回傳 TestClient。
"""
import importlib
import socket
import sys
import time
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from google.auth import crypt
from google.auth import jwt as google_jwt

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# 測試專用的假值（不是任何真實帳號 / 金鑰）
TEST_CLIENT_ID = "test-client-id.apps.googleusercontent.com"
TEST_SESSION_SECRET = "test-only-session-secret-0123456789abcdef0123456789abcdef"
TEST_KID = "test-kid"

ENV_KEYS = (
    "GIS_SESSION_SECRET",
    "GIS_GOOGLE_CLIENT_ID",
    "GIS_DEV_LOGIN",
    "GIS_COOKIE_SECURE",
    "GIS_CORS_ORIGINS",
    "GIS_MAX_PROJECT_MB",
)


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """測試不得連外網：只允許 loopback（Windows 上 socketpair 會走 127.0.0.1）。"""
    real_connect = socket.socket.connect

    def guarded(self, address):
        host = address[0] if isinstance(address, tuple) else address
        if host not in ("127.0.0.1", "::1", "localhost"):
            raise RuntimeError(f"tests must not touch the network: {address!r}")
        return real_connect(self, address)

    monkeypatch.setattr(socket.socket, "connect", guarded)


def _gen_keypair():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    public_pem = key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return private_pem, public_pem


_GOOGLE_KEY = _gen_keypair()   # 假裝是 Google 的簽章金鑰（certs 端點會回它）
_ATTACKER_KEY = _gen_keypair()  # 攻擊者自己的金鑰（不在 certs 裡）


@pytest.fixture(autouse=True)
def fake_google_certs(monkeypatch):
    """把 google-auth 抓 Google 公鑰的那一步換成回傳測試公鑰，其餘驗證邏輯照舊執行。"""
    from google.oauth2 import id_token as google_id_token

    def fake_fetch(request, certs_url):
        return {TEST_KID: _GOOGLE_KEY[1].decode()}

    monkeypatch.setattr(google_id_token, "_fetch_certs", fake_fetch)


def make_id_token(
    sub="1000001",
    email="alice@example.com",
    *,
    aud=TEST_CLIENT_ID,
    iss="https://accounts.google.com",
    exp_delta=3600,
    email_verified=True,
    signed_by_google=True,
    **extra,
):
    now = int(time.time())
    payload = {
        "iss": iss,
        "aud": aud,
        "sub": sub,
        "email": email,
        "email_verified": email_verified,
        "name": "Test User",
        "iat": now,
        "exp": now + exp_delta,
        **extra,
    }
    private_pem = (_GOOGLE_KEY if signed_by_google else _ATTACKER_KEY)[0]
    signer = crypt.RSASigner.from_string(private_pem, key_id=TEST_KID)
    return google_jwt.encode(signer, payload).decode()


@pytest.fixture
def make_client(tmp_path, monkeypatch):
    """回傳 factory：make_client(**env) → 以該環境變數重新載入後端並回傳 TestClient。

    預設是「正式站」設定：真的 Google client id、自訂 session secret、Secure cookie、
    dev-login 關閉。傳 GIS_XXX=None 代表刪掉該變數。
    """

    def _make(**env):
        settings = {
            "GIS_SESSION_SECRET": TEST_SESSION_SECRET,
            "GIS_GOOGLE_CLIENT_ID": TEST_CLIENT_ID,
            "GIS_COOKIE_SECURE": "1",
            **env,
        }
        for k in ENV_KEYS:
            monkeypatch.delenv(k, raising=False)
        for k, v in settings.items():
            if v is not None:
                monkeypatch.setenv(k, v)

        from server import db

        monkeypatch.setattr(db, "DB_PATH", tmp_path / "gis-test.db")
        from server import auth, main, routes

        importlib.reload(auth)
        importlib.reload(routes)
        importlib.reload(main)
        # https：Secure cookie 才會被 TestClient 的 cookie jar 帶回去
        return TestClient(main.app, base_url="https://testserver")

    return _make


@pytest.fixture
def client(make_client):
    return make_client()


def login(client, sub="1000001", email="alice@example.com"):
    r = client.post("/api/auth/google", json={"credential": make_id_token(sub=sub, email=email)})
    assert r.status_code == 200, r.text
    return r.json()["user"]


def another_client(client):
    """同一個 app、獨立 cookie jar：模擬另一個瀏覽器 / 另一位使用者。"""
    return TestClient(client.app, base_url="https://testserver")
