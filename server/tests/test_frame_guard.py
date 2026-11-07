"""所有回應都帶防框架標頭（X-Frame-Options: DENY + CSP frame-ancestors 'none'）。

同站子網域（*.tinghaochang.com）上的頁面可以用 iframe 嵌入 gis.tinghaochang.com，
瀏覽器會帶上 SameSite=Lax 的 session cookie；誘騙登入者在透明 iframe 上點「刪除專案」
就成了（請求是 GIS 自己的文件發出的，SameOriginWriteGuard 判為同源而放行）。
"""
from .conftest import login


def assert_unframeable(r):
    assert r.headers.get("x-frame-options") == "DENY", (r.status_code, dict(r.headers))
    csp = r.headers.get("content-security-policy", "")
    assert "frame-ancestors 'none'" in csp, (r.status_code, csp)


def test_api_success_response(client):
    login(client)
    r = client.get("/api/me")
    assert r.status_code == 200
    assert_unframeable(r)


def test_unauthenticated_401(client):
    r = client.get("/api/me")
    assert r.status_code == 401
    assert_unframeable(r)


def test_unknown_path_404(client):
    r = client.get("/api/this-route-does-not-exist")
    assert r.status_code == 404
    assert_unframeable(r)


def test_spa_root_and_static_404(client):
    # dist/ 存在時回 index.html（200），不存在時 404；兩種都要帶標頭
    for path in ("/", "/no-such-file.js"):
        assert_unframeable(client.get(path))


def test_cross_site_write_403_from_guard(client):
    r = client.post(
        "/api/projects",
        json={"name": "x"},
        headers={"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.tinghaochang.com"},
    )
    assert r.status_code == 403
    assert_unframeable(r)


def test_oversized_body_413_from_guard(client):
    r = client.post("/api/auth/google", content=b"x" * (70 * 1024), headers={"Content-Type": "application/json"})
    assert r.status_code == 413
    assert_unframeable(r)


def test_docs_are_404_but_still_framed_protected(client):
    # 與 test_api_docs 互補：被關掉的 /docs 回應也要帶標頭
    assert_unframeable(client.get("/docs"))
