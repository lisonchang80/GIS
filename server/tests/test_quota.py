"""每位使用者的儲存配額（審查 GIS-8）。

GIS_MAX_PROJECTS（預設 50）限制專案數，GIS_MAX_USER_MB（預設 500）限制所有專案
合計大小；單一專案 50 MB（GIS_MAX_PROJECT_MB）上限不變。超過回 413 與中文訊息。
"""
from .conftest import login

MB = 1024 * 1024


def _fresh_user(client):
    """登入並刪掉自動發的範例專案，讓配額從零算起。"""
    login(client)
    for p in client.get("/api/projects").json():
        client.delete(f"/api/projects/{p['id']}")
    assert client.get("/api/projects").json() == []


def _blob(mb: float):
    return {"version": 1, "layers": [{"blob": "x" * int(mb * MB)}]}


def test_project_count_is_capped(make_client):
    client = make_client(GIS_MAX_PROJECTS="3")
    _fresh_user(client)
    for i in range(3):
        assert client.post("/api/projects", json={"name": f"p{i}"}).status_code == 200
    r = client.post("/api/projects", json={"name": "too many"})
    assert r.status_code == 413
    assert "3" in r.json()["detail"] and "專案" in r.json()["detail"]
    assert len(client.get("/api/projects").json()) == 3
    # 刪掉一個就能再建
    client.delete(f"/api/projects/{client.get('/api/projects').json()[0]['id']}")
    assert client.post("/api/projects", json={"name": "again"}).status_code == 200


def test_total_size_is_capped_and_own_old_data_is_not_double_counted(make_client):
    client = make_client(GIS_MAX_USER_MB="2")
    _fresh_user(client)
    p1 = client.post("/api/projects", json={"name": "p1"}).json()["id"]
    p2 = client.post("/api/projects", json={"name": "p2"}).json()["id"]
    assert client.put(f"/api/projects/{p1}", json=_blob(0.9)).status_code == 200
    # 重存同一個專案：舊的 0.9 MB 要扣掉，不能算成 1.8 MB
    assert client.put(f"/api/projects/{p1}", json=_blob(0.9)).status_code == 200
    assert client.put(f"/api/projects/{p2}", json=_blob(0.9)).status_code == 200

    r = client.put(f"/api/projects/{p2}", json=_blob(1.3))
    assert r.status_code == 413
    detail = r.json()["detail"]
    assert "2 MB" in detail and "儲存空間" in detail
    # 被拒的存檔不能動到原本的資料
    assert len(client.get(f"/api/projects/{p2}").json()["layers"][0]["blob"]) == int(0.9 * MB)

    # 刪掉 p1 釋出空間後就能存
    client.delete(f"/api/projects/{p1}")
    assert client.put(f"/api/projects/{p2}", json=_blob(1.3)).status_code == 200


def test_quota_is_per_user(make_client):
    from .conftest import another_client

    client = make_client(GIS_MAX_USER_MB="1")
    _fresh_user(client)
    pid = client.post("/api/projects", json={"name": "a"}).json()["id"]
    assert client.put(f"/api/projects/{pid}", json=_blob(0.8)).status_code == 200
    bob = another_client(client)
    login(bob, sub="2000002", email="bob@example.com")
    for p in bob.get("/api/projects").json():
        bob.delete(f"/api/projects/{p['id']}")
    bid = bob.post("/api/projects", json={"name": "b"}).json()["id"]
    assert bob.put(f"/api/projects/{bid}", json=_blob(0.8)).status_code == 200


def test_defaults(make_client):
    from server import security

    make_client()
    assert security.max_projects() == 50
    assert security.max_user_bytes() == 500 * MB
    assert security.project_body_limit() == 50 * MB


def test_bad_env_values_fall_back_to_defaults(make_client):
    from server import security

    make_client(GIS_MAX_PROJECTS="abc", GIS_MAX_USER_MB="-5")
    assert security.max_projects() == 50
    assert security.max_user_bytes() == 500 * MB


def test_quota_sum_reads_only_the_index(client):
    # 9×20 MB 時，SUM 若要翻出每個專案的資料頁，每次存檔約 100 ms；只讀索引約 5 ms
    from server import db

    login(client)
    conn = db.get_conn()
    plan = " ".join(
        str(tuple(r)[-1])
        for r in conn.execute(
            "EXPLAIN QUERY PLAN SELECT COALESCE(SUM(size_bytes), 0) FROM projects WHERE user_id = ? AND id != ?",
            (1, 1),
        )
    )
    conn.close()
    assert "COVERING INDEX idx_projects_user_size" in plan


def test_rows_missing_size_are_still_counted(make_client):
    from server import db

    client = make_client(GIS_MAX_USER_MB="1")
    _fresh_user(client)
    p1 = client.post("/api/projects", json={"name": "p1"}).json()["id"]
    p2 = client.post("/api/projects", json={"name": "p2"}).json()["id"]
    assert client.put(f"/api/projects/{p1}", json=_blob(0.6)).status_code == 200
    conn = db.get_conn()
    conn.execute("UPDATE projects SET size_bytes = NULL WHERE id = ?", (p1,))
    conn.commit()
    conn.close()
    assert client.put(f"/api/projects/{p2}", json=_blob(0.6)).status_code == 413
