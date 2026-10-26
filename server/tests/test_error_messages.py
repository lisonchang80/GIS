"""錯誤回應不洩漏內部資訊（例外訊息、設定狀態、token 內容）。"""
from .conftest import make_id_token


def test_invalid_credential_message_is_generic(client):
    for token in ["x", make_id_token(exp_delta=-3600), make_id_token(aud="other-client")]:
        r = client.post("/api/auth/google", json={"credential": token})
        assert r.status_code == 401
        assert r.json() == {"detail": "invalid credential"}


def test_missing_client_id_is_a_server_error_without_details(make_client):
    # 部署檢查（gis-deploy skill）：401 = client id 有載入；500 = 環境沒吃到
    client = make_client(GIS_GOOGLE_CLIENT_ID=None)
    r = client.post("/api/auth/google", json={"credential": make_id_token()})
    assert r.status_code == 500
    assert "GIS_" not in r.text

