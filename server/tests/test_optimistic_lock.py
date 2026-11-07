"""同一專案開在兩個分頁／裝置：過期的分頁不能整包覆蓋較新的內容（審查 GIS-2）。

GET /api/projects/{id} 回 ETag（＝updated_at），PUT 帶 If-Match；版本不符回 409，
專案不存在回 404。沒帶 If-Match 的 PUT（API 腳本、舊版前端）維持無條件寫入。
另外 GET 直接回存好的 JSON 原文，不再解析後重新序列化（審查 GIS-5）。
"""
from .conftest import another_client, login

NEW = {"version": 1, "projectName": "P", "layers": [{"id": "b", "name": "B 分頁新增的井位"}]}
STALE = {"version": 1, "projectName": "P", "layers": []}


def _project(client):
    login(client)
    return client.post("/api/projects", json={"name": "P"}).json()["id"]


def test_get_returns_etag_and_put_returns_new_one(client):
    pid = _project(client)
    r = client.get(f"/api/projects/{pid}")
    assert r.status_code == 204  # 剛建立、還沒有內容
    etag = r.headers.get("etag")
    assert etag
    r = client.put(f"/api/projects/{pid}", json=NEW, headers={"If-Match": etag})
    assert r.status_code == 200, r.text
    new_etag = r.headers.get("etag")
    assert new_etag and new_etag != etag
    assert client.get(f"/api/projects/{pid}").headers.get("etag") == new_etag


def test_stale_tab_gets_409_and_does_not_overwrite(client):
    pid = _project(client)
    tab_a = client
    tab_b = another_client(client)
    tab_b.cookies.update(tab_a.cookies)
    etag_a = tab_a.get(f"/api/projects/{pid}").headers["etag"]
    etag_b = tab_b.get(f"/api/projects/{pid}").headers["etag"]
    assert tab_b.put(f"/api/projects/{pid}", json=NEW, headers={"If-Match": etag_b}).status_code == 200

    r = tab_a.put(f"/api/projects/{pid}", json=STALE, headers={"If-Match": etag_a})
    assert r.status_code == 409
    assert "其他分頁" in r.json()["detail"]
    assert tab_a.get(f"/api/projects/{pid}").json()["layers"] == NEW["layers"]


def test_consecutive_saves_with_returned_etag_never_conflict(client):
    pid = _project(client)
    etag = client.get(f"/api/projects/{pid}").headers["etag"]
    for i in range(5):
        body = {"version": 1, "projectName": "P", "layers": [{"id": str(i)}]}
        r = client.put(f"/api/projects/{pid}", json=body, headers={"If-Match": etag})
        assert r.status_code == 200, (i, r.text)
        etag = r.headers["etag"]


def test_weak_and_unquoted_etags_are_accepted(client):
    pid = _project(client)
    etag = client.get(f"/api/projects/{pid}").headers["etag"]
    raw = etag.strip('"')
    r = client.put(f"/api/projects/{pid}", json=NEW, headers={"If-Match": raw})
    assert r.status_code == 200
    r = client.put(f"/api/projects/{pid}", json=NEW, headers={"If-Match": "W/" + r.headers["etag"]})
    assert r.status_code == 200


def test_missing_project_is_404_not_409(client):
    pid = _project(client)
    etag = client.get(f"/api/projects/{pid}").headers["etag"]
    client.delete(f"/api/projects/{pid}")
    r = client.put(f"/api/projects/{pid}", json=NEW, headers={"If-Match": etag})
    assert r.status_code == 404


def test_other_users_project_is_404_even_with_matching_etag(client):
    pid = _project(client)
    etag = client.get(f"/api/projects/{pid}").headers["etag"]
    bob = another_client(client)
    login(bob, sub="2000002", email="bob@example.com")
    assert bob.put(f"/api/projects/{pid}", json=NEW, headers={"If-Match": etag}).status_code == 404


def test_put_without_if_match_still_works(client):
    # API 腳本（種子專案、示範專案產線）不帶 If-Match
    pid = _project(client)
    assert client.put(f"/api/projects/{pid}", json=NEW).status_code == 200
    assert client.get(f"/api/projects/{pid}").json()["layers"] == NEW["layers"]


def test_get_returns_stored_json_verbatim(client):
    from server import db

    pid = _project(client)
    assert client.put(f"/api/projects/{pid}", json=NEW).status_code == 200
    uid = client.get("/api/me").json()["user"]["id"]
    stored = db.get_project_by_id(uid, pid)["data"]
    r = client.get(f"/api/projects/{pid}")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    assert r.content == stored.encode("utf-8")
