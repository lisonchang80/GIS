"""同一帳號同時登入（雙擊、開兩個分頁）不能 500，也不能重複發範例專案。

upsert_user 先 SELECT 再 INSERT／發範例專案，兩個連線同時跑時都以為「還沒有這個人」。
"""
import threading

import pytest

from server import db


def _race(n, fn):
    barrier = threading.Barrier(n)
    errors = []

    def worker():
        barrier.wait()
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=worker) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return errors


@pytest.fixture
def fresh_db(make_client):
    make_client()  # 指到暫存 DB 並建表
    return db


def _counts(dbmod):
    conn = dbmod.get_conn()
    try:
        users = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        projects = conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
        return users, projects
    finally:
        conn.close()


@pytest.mark.parametrize("trial", range(3))
def test_concurrent_first_login_of_same_account(fresh_db, trial):
    errors = _race(8, lambda: fresh_db.upsert_user("same-sub", "a@example.com", "A", None))
    assert errors == []
    assert _counts(fresh_db) == (1, 1)  # 一個使用者、一份範例專案


@pytest.mark.parametrize("trial", range(3))
def test_concurrent_login_of_unseeded_existing_user_seeds_once(fresh_db, trial):
    conn = fresh_db.get_conn()
    conn.execute(
        "INSERT INTO users (google_sub, email, created_at, seeded_demo) VALUES ('old', 'o@example.com', 'x', 0)"
    )
    conn.commit()
    conn.close()
    errors = _race(8, lambda: fresh_db.upsert_user("old", "o@example.com", "O", None))
    assert errors == []
    assert _counts(fresh_db) == (1, 1)
