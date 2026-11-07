"""每位使用者只能讀寫自己的專案（IDOR 回歸測試）。"""
from .conftest import another_client, login

PROJECT = {"version": 1, "projectName": "A 的專案", "layers": [{"id": "l1", "name": "secret"}]}


def _two_users(client):
    alice = client
    login(alice, sub="1000001", email="alice@example.com")
    bob = another_client(client)
    login(bob, sub="2000002", email="bob@example.com")
    return alice, bob


def test_cannot_touch_other_users_project_by_id(client):
    alice, bob = _two_users(client)
    pid = alice.post("/api/projects", json={"name": "A"}).json()["id"]
    assert alice.put(f"/api/projects/{pid}", json=PROJECT).status_code == 200

    # Bob 拿 Alice 的 id：讀、改、刪 全部擋下
    assert bob.get(f"/api/projects/{pid}").status_code == 404
    assert bob.put(f"/api/projects/{pid}", json={"version": 1, "layers": []}).status_code == 404
    bob.delete(f"/api/projects/{pid}")
    assert pid not in [p["id"] for p in bob.get("/api/projects").json()]

    # Alice 的資料原封不動
    r = alice.get(f"/api/projects/{pid}")
    assert r.status_code == 200
    assert r.json()["layers"] == PROJECT["layers"]
    names = {p["id"]: p["name"] for p in alice.get("/api/projects").json()}
    assert names[pid] == "A 的專案"


def test_legacy_single_project_endpoints_are_gone(client):
    # 舊的 DELETE /api/project 會刪光該使用者「全部」專案；前端早已不用，整組移除
    login(client)
    pid = client.post("/api/projects", json={"name": "A"}).json()["id"]
    assert client.put(f"/api/projects/{pid}", json=PROJECT).status_code == 200
    client.post("/api/projects", json={"name": "B"})  # 最新的是空專案（舊 GET 會 500）
    before = len(client.get("/api/projects").json())
    # 路由已不存在；有 dist/ 時靜態檔 mount 對寫入方法回 405
    assert client.get("/api/project").status_code == 404
    assert client.put("/api/project", json=PROJECT).status_code in (404, 405)
    assert client.delete("/api/project").status_code in (404, 405)
    assert client.patch(f"/api/projects/{pid}", json={"name": "x"}).status_code == 405
    assert len(client.get("/api/projects").json()) == before
    assert client.get(f"/api/projects/{pid}").json()["layers"] == PROJECT["layers"]


def test_every_project_endpoint_requires_login(client):
    for method, path in [
        ("get", "/api/me"),
        ("get", "/api/projects"),
        ("post", "/api/projects"),
        ("get", "/api/projects/1"),
        ("put", "/api/projects/1"),
        ("delete", "/api/projects/1"),
    ]:
        kwargs = {"json": {"version": 1, "name": "x"}} if method in ("put", "post") else {}
        r = getattr(client, method)(path, **kwargs)
        assert r.status_code == 401, (method, path, r.status_code)


def test_sql_metacharacters_are_stored_literally(client):
    login(client)
    evil = "x'); DROP TABLE projects; --"
    pid = client.post("/api/projects", json={"name": evil}).json()["id"]
    client.put(f"/api/projects/{pid}", json={"version": 1, "projectName": evil + "2", "layers": []})
    names = [p["name"] for p in client.get("/api/projects").json()]
    assert evil + "2" in names


def test_dev_login_is_off_unless_explicitly_enabled(make_client):
    assert make_client().post("/api/auth/dev-login").status_code == 404
    assert make_client(GIS_DEV_LOGIN="0").post("/api/auth/dev-login").status_code == 404
    assert make_client(GIS_DEV_LOGIN="true").post("/api/auth/dev-login").status_code == 404
    dev = make_client(GIS_DEV_LOGIN="1", GIS_COOKIE_SECURE="0")
    assert dev.post("/api/auth/dev-login").status_code == 200
