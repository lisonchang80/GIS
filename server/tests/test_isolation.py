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

    # Bob 拿 Alice 的 id：讀、改、改名、刪 全部擋下
    assert bob.get(f"/api/projects/{pid}").status_code == 404
    assert bob.put(f"/api/projects/{pid}", json={"version": 1, "layers": []}).status_code == 404
    assert bob.patch(f"/api/projects/{pid}", json={"name": "pwned"}).status_code == 404
    bob.delete(f"/api/projects/{pid}")
    assert pid not in [p["id"] for p in bob.get("/api/projects").json()]

    # Alice 的資料原封不動
    r = alice.get(f"/api/projects/{pid}")
    assert r.status_code == 200
    assert r.json()["layers"] == PROJECT["layers"]
    names = {p["id"]: p["name"] for p in alice.get("/api/projects").json()}
    assert names[pid] == "A 的專案"


def test_legacy_single_project_endpoint_is_per_user(client):
    alice, bob = _two_users(client)
    assert alice.put("/api/project", json=PROJECT).status_code == 200
    assert bob.delete("/api/project").status_code == 200  # 只清掉 Bob 自己的
    assert bob.get("/api/project").status_code == 204
    assert alice.get("/api/project").json()["layers"] == PROJECT["layers"]


def test_every_project_endpoint_requires_login(client):
    for method, path in [
        ("get", "/api/me"),
        ("get", "/api/project"),
        ("put", "/api/project"),
        ("delete", "/api/project"),
        ("get", "/api/projects"),
        ("post", "/api/projects"),
        ("get", "/api/projects/1"),
        ("put", "/api/projects/1"),
        ("patch", "/api/projects/1"),
        ("delete", "/api/projects/1"),
    ]:
        kwargs = {"json": {"version": 1, "name": "x"}} if method in ("put", "post", "patch") else {}
        r = getattr(client, method)(path, **kwargs)
        assert r.status_code == 401, (method, path, r.status_code)


def test_sql_metacharacters_are_stored_literally(client):
    login(client)
    evil = "x'); DROP TABLE projects; --"
    pid = client.post("/api/projects", json={"name": evil}).json()["id"]
    client.patch(f"/api/projects/{pid}", json={"name": evil + "2"})
    names = [p["name"] for p in client.get("/api/projects").json()]
    assert evil + "2" in names


def test_dev_login_is_off_unless_explicitly_enabled(make_client):
    assert make_client().post("/api/auth/dev-login").status_code == 404
    assert make_client(GIS_DEV_LOGIN="0").post("/api/auth/dev-login").status_code == 404
    assert make_client(GIS_DEV_LOGIN="true").post("/api/auth/dev-login").status_code == 404
    dev = make_client(GIS_DEV_LOGIN="1", GIS_COOKIE_SECURE="0")
    assert dev.post("/api/auth/dev-login").status_code == 200
