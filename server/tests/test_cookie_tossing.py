"""子網域 cookie tossing：其他 *.tinghaochang.com 頁面種下的 session cookie 不能被採用。

evil.tinghaochang.com 可以用 `document.cookie = "gis_session=<攻擊者的 session>;
Domain=tinghaochang.com; Path=/"` 種一個 cookie，瀏覽器之後打 gis.tinghaochang.com
會同時送出兩個同名 cookie；Starlette 取最後一個（較新建立的＝攻擊者的），
受害者就在不知情下用攻擊者的帳號工作，匯入的資料全存進攻擊者那裡。
`__Host-` 前綴的 cookie 瀏覽器只接受 Secure、Path=/、無 Domain 的設定，
子網域種不了同名 cookie。
"""
from server import auth

from .conftest import another_client, login


def _session_value(client):
    return client.cookies.get(auth.COOKIE_NAME)


def test_production_cookie_uses_host_prefix(client):
    login(client)
    assert auth.COOKIE_NAME.startswith("__Host-")
    set_cookie = client.post("/api/auth/logout").headers["set-cookie"].lower()
    # 刪除 __Host- cookie 的 Set-Cookie 也必須帶 Secure + Path=/，否則瀏覽器不理
    assert set_cookie.startswith(auth.COOKIE_NAME.lower() + "=")
    assert "secure" in set_cookie and "path=/" in set_cookie and "max-age=0" in set_cookie


def test_tossed_cookie_from_sibling_subdomain_is_ignored(client):
    login(client, sub="1000001", email="victim@example.com")
    victim_session = _session_value(client)
    attacker = another_client(client)
    login(attacker, sub="6666666", email="attacker@example.com")
    attacker_session = _session_value(attacker)

    # 瀏覽器送出的 Cookie header：受害者自己的 host-only cookie 在前，攻擊者用
    # Domain=tinghaochang.com 種的 gis_session 在後（同路徑時較新建立的排後面）
    browser = another_client(client)
    header = f"{auth.COOKIE_NAME}={victim_session}; gis_session={attacker_session}"
    me = browser.get("/api/me", headers={"Cookie": header})
    assert me.status_code == 200
    assert me.json()["user"]["email"] == "victim@example.com"

    # 受害者尚未登入時，種下的 cookie 也不能讓他「登入」攻擊者的帳號
    only_tossed = browser.get("/api/me", headers={"Cookie": f"gis_session={attacker_session}"})
    assert only_tossed.status_code == 401


def test_plain_http_dev_keeps_unprefixed_cookie(make_client):
    from fastapi.testclient import TestClient

    dev = make_client(GIS_DEV_LOGIN="1", GIS_COOKIE_SECURE="0")
    dev = TestClient(dev.app, base_url="http://testserver")
    assert dev.post("/api/auth/dev-login").status_code == 200
    assert auth.COOKIE_NAME == "gis_session"
    assert dev.get("/api/me").status_code == 200
