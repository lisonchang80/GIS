"""SQLite storage for GIS users + projects.

Single-file embedded DB (no server / no admin needed). The project blob is the
exact ProjectState JSON the frontend already serializes; we do not decompose
layers into rows (PostGIS decomposition is a future upgrade).
"""
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / "gis.db"

# 每位新使用者首次登入時自動獲得的預設範本專案（來源：Demo/ 匯出檔）。
SEED_PATH = Path(__file__).parent / "seed_demo.json"
_seed_raw: str | None = None
_seed_meta: dict | None = None


def _load_seed():
    """回傳 (raw_json_text, {name, version})；找不到或壞掉則回傳 ('', {})，靜默略過種子。"""
    global _seed_raw, _seed_meta
    if _seed_raw is None:
        try:
            raw = SEED_PATH.read_text(encoding="utf-8")
            meta = json.loads(raw)
            _seed_raw = raw
            _seed_meta = {
                "name": meta.get("projectName") or "範例專案",
                "version": int(meta.get("version", 1)),
            }
        except (OSError, ValueError):
            _seed_raw = ""
            _seed_meta = {}
    return _seed_raw, _seed_meta

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  google_sub  TEXT UNIQUE NOT NULL,
  email       TEXT NOT NULL,
  name        TEXT,
  picture     TEXT,
  created_at  TEXT NOT NULL,
  last_login  TEXT,
  seeded_demo INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL DEFAULT 'My Project',
  version     INTEGER NOT NULL,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    conn = get_conn()
    try:
        conn.executescript(SCHEMA)
        # Migration：既有 DB（在加入預設範本功能之前建立）補上 seeded_demo 欄位，
        # 讓舊使用者下次登入也能補發一次預設範本。
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
        if "seeded_demo" not in cols:
            conn.execute("ALTER TABLE users ADD COLUMN seeded_demo INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    finally:
        conn.close()


def upsert_user(google_sub: str, email: str, name, picture) -> int:
    conn = get_conn()
    try:
        ts = now_iso()
        row = conn.execute(
            "SELECT id, seeded_demo FROM users WHERE google_sub = ?", (google_sub,)
        ).fetchone()
        if row:
            uid = row["id"]
            already_seeded = bool(row["seeded_demo"])
            conn.execute(
                "UPDATE users SET email=?, name=?, picture=?, last_login=? WHERE id=?",
                (email, name, picture, ts, uid),
            )
        else:
            cur = conn.execute(
                "INSERT INTO users (google_sub, email, name, picture, created_at, last_login)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (google_sub, email, name, picture, ts, ts),
            )
            uid = cur.lastrowid
            already_seeded = False
        # 每位使用者一次性灌入預設範本專案（含尚未種過的既有舊使用者，靠 seeded_demo 旗標）。
        # 找不到種子檔則保持旗標為 0，日後補上檔案再重啟仍會補發。
        if not already_seeded:
            seed_raw, seed_meta = _load_seed()
            if seed_raw:
                conn.execute(
                    "INSERT INTO projects (user_id, name, version, data, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (uid, seed_meta["name"], seed_meta["version"], seed_raw, ts, ts),
                )
                conn.execute("UPDATE users SET seeded_demo=1 WHERE id=?", (uid,))
        conn.commit()
        return uid
    finally:
        conn.close()


def get_user(uid: int):
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_project(uid: int):
    """Most-recent project for the user (MVP = single project per user)."""
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1",
            (uid,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def put_project(uid: int, version: int, data_json: str, name: str = "My Project") -> str:
    conn = get_conn()
    try:
        ts = now_iso()
        existing = conn.execute(
            "SELECT id FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1",
            (uid,),
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE projects SET version=?, data=?, updated_at=? WHERE id=?",
                (version, data_json, ts, existing["id"]),
            )
        else:
            conn.execute(
                "INSERT INTO projects (user_id, name, version, data, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (uid, name, version, data_json, ts, ts),
            )
        conn.commit()
        return ts
    finally:
        conn.close()


def delete_project(uid: int) -> None:
    conn = get_conn()
    try:
        conn.execute("DELETE FROM projects WHERE user_id = ?", (uid,))
        conn.commit()
    finally:
        conn.close()


# ---- multi-project (explicit ids, all scoped to the owner) ----
def list_projects(uid: int):
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, name, updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC",
            (uid,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def create_project(uid: int, name: str = "未命名專案"):
    conn = get_conn()
    try:
        ts = now_iso()
        cur = conn.execute(
            "INSERT INTO projects (user_id, name, version, data, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (uid, name, 1, "", ts, ts),
        )
        conn.commit()
        return {"id": cur.lastrowid, "name": name, "updated_at": ts}
    finally:
        conn.close()


def get_project_by_id(uid: int, pid: int):
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM projects WHERE id = ? AND user_id = ?", (pid, uid)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def update_project_by_id(uid: int, pid: int, version: int, data_json: str, name: str):
    conn = get_conn()
    try:
        ts = now_iso()
        cur = conn.execute(
            "UPDATE projects SET version=?, data=?, name=?, updated_at=? WHERE id=? AND user_id=?",
            (version, data_json, name, ts, pid, uid),
        )
        conn.commit()
        return cur.rowcount > 0, ts
    finally:
        conn.close()


def rename_project_by_id(uid: int, pid: int, name: str) -> bool:
    conn = get_conn()
    try:
        cur = conn.execute(
            "UPDATE projects SET name=?, updated_at=? WHERE id=? AND user_id=?",
            (name, now_iso(), pid, uid),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def delete_project_by_id(uid: int, pid: int) -> bool:
    conn = get_conn()
    try:
        cur = conn.execute(
            "DELETE FROM projects WHERE id = ? AND user_id = ?", (pid, uid)
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()
