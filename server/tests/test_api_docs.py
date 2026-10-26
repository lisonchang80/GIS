"""正式站不提供 /docs、/redoc、/openapi.json。

Swagger UI 頁面會從 cdn.jsdelivr.net 載入 JS 並在 gis.tinghaochang.com 的同源下執行；
登入者打開 /docs 時，第三方腳本就能以他的 cookie 呼叫所有 API。開發模式保留方便除錯。
"""
DOC_PATHS = ["/docs", "/redoc", "/openapi.json"]


def test_api_docs_hidden_in_production(client):
    for path in DOC_PATHS:
        assert client.get(path).status_code == 404, path


def test_api_docs_available_in_dev(make_client):
    dev = make_client(GIS_DEV_LOGIN="1", GIS_COOKIE_SECURE="0")
    for path in DOC_PATHS:
        assert dev.get(path).status_code == 200, path
