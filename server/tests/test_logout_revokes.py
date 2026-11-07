"""登出要在伺服器端作廢 session（審查 GA-9 的 GIS 部分）。

users.session_version 跟著 cookie 走；登出就 +1，之前簽出的 cookie（包括被複製走的）
一律失效。沒有版本號的舊格式 cookie 也當成未登入。
"""
import sqlite3

from .conftest import another_client, login


def _cookie_value(client):
    from server import auth

    return client.cookies.get(auth.COOKIE_NAME)


def test_logout_revokes_copied_cookie(client):
    from server import auth

    login(client)
    stolen = _cookie_value(client)
    assert stolen
    thief = another_client(client)
    thief.cookies.set(auth.COOKIE_NAME, stolen)
    assert thief.get("/api/me").status_code == 200

    assert client.post("/api/auth/logout").status_code == 200
    assert thief.get("/api/me").status_code == 401
    assert thief.get("/api/projects").status_code == 401


def test_logout_revokes_other_devices_and_relogin_works(client):
    login(client)
    other_device = another_client(client)
    login(other_device)
    assert other_device.get("/api/me").status_code == 200
    client.post("/api/auth/logout")
    assert other_device.get("/api/me").status_code == 401
    login(other_device)
    assert other_device.get("/api/me").status_code == 200


def test_old_format_cookie_without_version_is_rejected(client):
    from server import auth

    user = login(client)
    legacy = auth._serializer.dumps({"uid": user["id"]})
    c = another_client(client)
    c.cookies.set(auth.COOKIE_NAME, legacy)
    assert c.get("/api/me").status_code == 401


def test_cookie_for_unknown_user_is_rejected(client):
    from server import auth

    login(client)
    c = another_client(client)
    c.cookies.set(auth.COOKIE_NAME, auth.make_session(999, 0))
    assert c.get("/api/me").status_code == 401


def test_logout_without_session_is_harmless(client):
    assert client.post("/api/auth/logout").status_code == 200


def test_migration_adds_column_and_is_repeatable(tmp_path, monkeypatch):
    from server import db

    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE users (id INTEGER PRIMARY KEY, google_sub TEXT UNIQUE NOT NULL,
          email TEXT NOT NULL, name TEXT, picture TEXT, created_at TEXT NOT NULL, last_login TEXT);
        INSERT INTO users (google_sub, email, created_at) VALUES ('s1', 'a@example.com', 'x');
        CREATE TABLE projects (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
          name TEXT NOT NULL DEFAULT 'My Project', version INTEGER NOT NULL, data TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        INSERT INTO projects (user_id, name, version, data, created_at, updated_at)
          VALUES (1, 'old', 1, '{"version":1,"layers":[]}', 'x', 'x');
        """
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(db, "DB_PATH", path)
    db.init_db()
    db.init_db()  # 第二次啟動不能出錯

    conn = sqlite3.connect(path)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(users)")]
    assert "session_version" in cols and "seeded_demo" in cols
    assert conn.execute("SELECT email, session_version FROM users").fetchall() == [("a@example.com", 0)]
    pcols = [r[1] for r in conn.execute("PRAGMA table_info(projects)")]
    assert "size_bytes" in pcols
    # 既有資料保留，大小補算好
    assert conn.execute("SELECT name, data, size_bytes FROM projects").fetchall() == [
        ("old", '{"version":1,"layers":[]}', len('{"version":1,"layers":[]}'))
    ]
    conn.close()
