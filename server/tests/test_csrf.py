"""寫入端點的 CSRF：同站其他子網域（*.tinghaochang.com）的頁面不能帶著 cookie 打進來。

SameSite=Lax 只擋「跨站」；evil.tinghaochang.com → gis.tinghaochang.com 算「同站」，
瀏覽器照樣附上 cookie。像 POST /api/auth/logout 這種 simple request 不需要 CORS
preflight，現況會直接被執行。修正後伺服器以 Sec-Fetch-Site / Origin 判斷來源。
"""
import pytest

from server import auth

from .conftest import login

SIBLING = {"Origin": "https://evil.tinghaochang.com", "Sec-Fetch-Site": "same-site"}
CROSS = {"Origin": "https://attacker.example", "Sec-Fetch-Site": "cross-site"}
OLD_BROWSER_SIBLING = {"Origin": "https://evil.tinghaochang.com"}  # 沒有 Sec-Fetch-* 的舊瀏覽器
SAME_ORIGIN = {"Origin": "https://testserver", "Sec-Fetch-Site": "same-origin"}


@pytest.fixture
def authed(client):
    login(client)
    pid = client.post("/api/projects", json={"name": "原名"}).json()["id"]
    client.put(f"/api/projects/{pid}", json={"version": 1, "projectName": "原名", "layers": [1]})
    return client, pid


@pytest.mark.parametrize("headers", [SIBLING, CROSS, OLD_BROWSER_SIBLING])
def test_cross_site_logout_is_blocked(authed, headers):
    client, _ = authed
    r = client.post("/api/auth/logout", headers=headers)
    assert r.status_code == 403
    assert auth.COOKIE_NAME not in r.headers.get("set-cookie", "")
    assert client.get("/api/me").status_code == 200


@pytest.mark.parametrize("headers", [SIBLING, CROSS, OLD_BROWSER_SIBLING])
def test_cross_site_project_writes_are_blocked(authed, headers):
    client, pid = authed
    before = len(client.get("/api/projects").json())
    assert client.post("/api/projects", json={"name": "x"}, headers=headers).status_code == 403
    assert client.patch(f"/api/projects/{pid}", json={"name": "x"}, headers=headers).status_code == 403
    assert client.put(f"/api/projects/{pid}", json={"version": 1, "layers": []}, headers=headers).status_code == 403
    assert client.put("/api/project", json={"version": 1, "layers": []}, headers=headers).status_code == 403
    assert client.delete(f"/api/projects/{pid}", headers=headers).status_code == 403
    assert client.delete("/api/project", headers=headers).status_code == 403

    assert len(client.get("/api/projects").json()) == before
    assert client.get(f"/api/projects/{pid}").json()["layers"] == [1]


def test_cross_site_login_is_blocked(client):
    # 登入 CSRF：把受害者登進攻擊者的帳號，之後受害者匯入的資料就存進攻擊者那裡
    from .conftest import make_id_token

    r = client.post("/api/auth/google", json={"credential": make_id_token()}, headers=SIBLING)
    assert r.status_code == 403


def test_same_origin_and_non_browser_clients_still_work(authed):
    client, pid = authed
    r = client.patch(f"/api/projects/{pid}", json={"name": "新名"}, headers=SAME_ORIGIN)
    assert r.status_code == 200
    # 舊瀏覽器沒有 Sec-Fetch-Site，但 Origin 與 Host 相同
    r = client.patch(f"/api/projects/{pid}", json={"name": "新名2"}, headers={"Origin": "https://testserver"})
    assert r.status_code == 200
    # 使用者自己在網址列操作（Sec-Fetch-Site: none）與 curl／腳本（不帶 Origin）
    r = client.patch(f"/api/projects/{pid}", json={"name": "新名3"}, headers={"Sec-Fetch-Site": "none"})
    assert r.status_code == 200
    assert client.patch(f"/api/projects/{pid}", json={"name": "新名4"}).status_code == 200


def test_reads_are_not_affected(authed):
    client, _ = authed
    assert client.get("/api/projects", headers=SIBLING).status_code == 200
