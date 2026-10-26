"""存檔端點的輸入驗證：壞資料回 4xx，不能 500，也不能寫進一筆之後讀不出來的專案。"""
import pytest
from fastapi.testclient import TestClient

from .conftest import login

BAD_BODIES = [
    '{"version": "not-a-number", "layers": []}',
    '{"version": [1], "layers": []}',
    '{"version": 1e30, "layers": []}',
    '{"version": 1, "projectName": {"a": 1}, "layers": []}',
    '{"version": 1, "layers": [NaN]}',
    '{"version": 1, "layers": [], "x": Infinity}',
    "this is not json",
]


@pytest.fixture
def authed(client):
    login(client)
    # 不把伺服器例外直接丟進測試，才看得到用戶端實際收到的狀態碼
    c = TestClient(client.app, base_url="https://testserver", raise_server_exceptions=False)
    c.cookies = client.cookies
    pid = c.post("/api/projects", json={"name": "p"}).json()["id"]
    assert c.put(f"/api/projects/{pid}", json={"version": 1, "projectName": "p", "layers": [1]}).status_code == 200
    return c, pid


@pytest.mark.parametrize("body", BAD_BODIES)
@pytest.mark.parametrize("path", ["/api/projects/{pid}", "/api/project"])
def test_bad_project_bodies_are_rejected_cleanly(authed, body, path):
    c, pid = authed
    r = c.put(path.format(pid=pid), content=body, headers={"Content-Type": "application/json"})
    assert 400 <= r.status_code < 500, (body, r.status_code)
    # 原本存好的專案仍然讀得出來、沒被覆蓋
    r = c.get(f"/api/projects/{pid}")
    assert r.status_code == 200
    assert r.json()["layers"] == [1]
