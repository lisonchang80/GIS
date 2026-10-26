"""請求大小上限：匿名者不能讓伺服器把任意大的 body 讀進記憶體。

FastAPI 對 Pydantic body 的端點（例如 POST /api/auth/google）會在跑登入檢查
之前就把整個 body 讀完並 JSON 解析；uvicorn 本身沒有上限。Cloudflare 免費方案
每個請求可到 100 MB，同時多送幾個就能把這台家用 PC 的記憶體吃光。
"""
from .conftest import login, make_id_token

BIG = 1024 * 1024  # 1 MB：遠大於任何合法的登入 / 建立 / 改名請求


def test_anonymous_huge_login_body_is_rejected(client):
    body = '{"credential": "' + "a" * BIG + '"}'
    r = client.post("/api/auth/google", content=body, headers={"Content-Type": "application/json"})
    assert r.status_code == 413


def test_chunked_body_without_content_length_is_rejected(client):
    def chunks():
        yield b'{"credential": "'
        for _ in range(16):
            yield b"a" * (BIG // 16)
        yield b'"}'

    r = client.post("/api/auth/google", content=chunks(), headers={"Content-Type": "application/json"})
    assert r.status_code == 413


def test_huge_create_and_rename_are_rejected(client):
    login(client)
    assert client.post("/api/projects", json={"name": "a" * BIG}).status_code == 413
    pid = client.post("/api/projects", json={"name": "ok"}).json()["id"]
    assert client.patch(f"/api/projects/{pid}", json={"name": "a" * BIG}).status_code == 413


def test_normal_requests_and_project_saves_still_work(client):
    r = client.post("/api/auth/google", json={"credential": make_id_token()})
    assert r.status_code == 200
    pid = client.post("/api/projects", json={"name": "ok"}).json()["id"]
    project = {"version": 1, "projectName": "大專案", "layers": [{"blob": "x" * (5 * BIG)}]}
    assert client.put(f"/api/projects/{pid}", json=project).status_code == 200
    assert client.put("/api/project", json=project).status_code == 200
    assert len(client.get(f"/api/projects/{pid}").json()["layers"][0]["blob"]) == 5 * BIG
