"""【待使用者決定】Google 回報 email 未驗證的帳號不能登入。

帳號識別用的是 `sub`，所以這不會讓人冒充別人的專案；但未驗證的 email 會被當成
使用者的 email 存進 DB、顯示在畫面上。
"""
from .conftest import make_id_token


def test_unverified_email_is_rejected(client):
    r = client.post("/api/auth/google", json={"credential": make_id_token(email_verified=False)})
    assert r.status_code == 401
    assert client.get("/api/me").status_code == 401


def test_verified_email_logs_in(client):
    r = client.post("/api/auth/google", json={"credential": make_id_token(email_verified=True)})
    assert r.status_code == 200
