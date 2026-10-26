"""CORS：正式站預設不信任任何其他來源（前端一律同源：prod 由 FastAPI 供應 dist/、dev 走 Vite proxy）。"""

PREFLIGHT = {
    "Origin": "http://localhost:5173",
    "Access-Control-Request-Method": "PUT",
    "Access-Control-Request-Headers": "content-type",
}


def test_no_cross_origin_is_trusted_by_default(client):
    r = client.options("/api/projects/1", headers=PREFLIGHT)
    assert "access-control-allow-origin" not in r.headers
    r = client.get("/api/me", headers={"Origin": "http://localhost:5173"})
    assert "access-control-allow-origin" not in r.headers
    # 跨來源寫入也不會因為「預設信任 localhost:5173」而通過來源檢查
    r = client.post("/api/auth/logout", headers={"Origin": "http://localhost:5173", "Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403


def test_explicit_cors_origin_still_works(make_client):
    client = make_client(GIS_CORS_ORIGINS="http://localhost:5173")
    r = client.options("/api/projects/1", headers=PREFLIGHT)
    assert r.headers.get("access-control-allow-origin") == "http://localhost:5173"
    assert r.headers.get("access-control-allow-credentials") == "true"
