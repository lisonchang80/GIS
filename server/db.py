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
  seeded_demo INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL DEFAULT 'My Project',
  version     INTEGER NOT NULL,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  size_bytes  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
"""


class ProjectNotFound(Exception):
    """The project does not exist (or belongs to someone else)."""


class RevisionConflict(Exception):
    """The project changed since the client loaded it (another tab / device saved)."""


class QuotaExceeded(Exception):
    def __init__(self, kind: str, limit: int, used: int = 0, requested: int = 0):
        super().__init__(kind)
        self.kind = kind  # "projects" | "bytes"
        self.limit = limit
        self.used = used
        self.requested = requested


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
        # Migration（只加不刪、可重複執行）：登出時 +1 的 session 版本號，舊 cookie 隨之失效。
        if "session_version" not in cols:
            conn.execute("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0")
        # Migration：專案大小（位元組）快取，配額檢查不必每次讀出所有專案的內容。
        pcols = [r["name"] for r in conn.execute("PRAGMA table_info(projects)").fetchall()]
        if "size_bytes" not in pcols:
            conn.execute("ALTER TABLE projects ADD COLUMN size_bytes INTEGER")
        conn.execute(
            "UPDATE projects SET size_bytes = LENGTH(CAST(data AS BLOB)) WHERE size_bytes IS NULL"
        )
        # 配額的 SUM 只讀這個索引，不必翻出每個專案的資料頁（要在 size_bytes 補上之後才能建）
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_projects_user_size ON projects(user_id, size_bytes)"
        )
        conn.commit()
    finally:
        conn.close()


def upsert_user(google_sub: str, email: str, name, picture) -> int:
    conn = get_conn()
    try:
        # 先拿寫入鎖再 SELECT：同一帳號同時登入（雙擊、多分頁）時，否則兩邊都以為
        # 「還沒有這個人／還沒發範本」→ UNIQUE 衝突 500，或重複發好幾份範例專案。
        conn.execute("BEGIN IMMEDIATE")
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
                    "INSERT INTO projects"
                    " (user_id, name, version, data, created_at, updated_at, size_bytes)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        uid, seed_meta["name"], seed_meta["version"], seed_raw, ts, ts,
                        len(seed_raw.encode("utf-8")),
                    ),
                )
                conn.execute("UPDATE users SET seeded_demo=1 WHERE id=?", (uid,))
        conn.commit()
        return uid
    finally:
        conn.close()


def get_session_version(uid: int):
    """None = no such user (a cookie for a deleted / unknown uid is not a session)."""
    conn = get_conn()
    try:
        row = conn.execute("SELECT session_version FROM users WHERE id = ?", (uid,)).fetchone()
        return int(row["session_version"]) if row else None
    finally:
        conn.close()


def bump_session_version(uid: int) -> None:
    """Logout: every cookie issued so far for this user (all devices) stops working."""
    conn = get_conn()
    try:
        conn.execute("UPDATE users SET session_version = session_version + 1 WHERE id = ?", (uid,))
        conn.commit()
    finally:
        conn.close()


def get_user(uid: int):
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        return dict(row) if row else None
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


def create_project(uid: int, name: str = "未命名專案", max_projects: int | None = None):
    conn = get_conn()
    try:
        # 先拿寫入鎖：同時送出的多個 POST 不能一起擠過數量上限
        conn.execute("BEGIN IMMEDIATE")
        if max_projects is not None:
            count = conn.execute(
                "SELECT COUNT(*) FROM projects WHERE user_id = ?", (uid,)
            ).fetchone()[0]
            if count >= max_projects:
                raise QuotaExceeded("projects", max_projects, used=count)
        ts = now_iso()
        cur = conn.execute(
            "INSERT INTO projects (user_id, name, version, data, created_at, updated_at, size_bytes)"
            " VALUES (?, ?, ?, ?, ?, ?, 0)",
            (uid, name, 1, "", ts, ts),
        )
        conn.commit()
        return {"id": cur.lastrowid, "name": name, "updated_at": ts}
    finally:
        conn.rollback()  # no-op after commit; releases the lock on the error paths
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


def update_project_by_id(
    uid: int,
    pid: int,
    version: int,
    data_json: str,
    name: str,
    expected_updated_at: str | None = None,
    max_user_bytes: int | None = None,
) -> str:
    """Write the project and return its new updated_at (= the new revision / ETag).

    expected_updated_at is an optimistic lock: the write only lands if the stored
    updated_at still equals it, so a stale tab can't overwrite newer content.
    Raises ProjectNotFound / RevisionConflict / QuotaExceeded; nothing is written then.
    """
    size = len(data_json.encode("utf-8"))
    conn = get_conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT updated_at FROM projects WHERE id = ? AND user_id = ?", (pid, uid)
        ).fetchone()
        if not row:
            raise ProjectNotFound()
        if expected_updated_at is not None and row["updated_at"] != expected_updated_at:
            raise RevisionConflict()
        if max_user_bytes is not None:
            # 其他專案合計（不含這個專案的舊資料）＋這次的大小。先補算萬一缺的
            # size_bytes（正常不會有），SUM 才能只讀 idx_projects_user_size 索引。
            conn.execute(
                "UPDATE projects SET size_bytes = LENGTH(CAST(data AS BLOB))"
                " WHERE user_id = ? AND size_bytes IS NULL",
                (uid,),
            )
            used = conn.execute(
                "SELECT COALESCE(SUM(size_bytes), 0) FROM projects WHERE user_id = ? AND id != ?",
                (uid, pid),
            ).fetchone()[0]
            if used + size > max_user_bytes:
                raise QuotaExceeded("bytes", max_user_bytes, used=used, requested=size)
        ts = now_iso()
        while ts == row["updated_at"]:  # 時鐘解析度不足時也要換出新的版本號
            ts = now_iso()
        cur = conn.execute(
            "UPDATE projects SET version=?, data=?, name=?, updated_at=?, size_bytes=?"
            " WHERE id=? AND user_id=? AND updated_at=?",
            (version, data_json, name, ts, size, pid, uid, row["updated_at"]),
        )
        if cur.rowcount == 0:  # 不會發生（已持有寫入鎖），保險起見
            raise RevisionConflict()
        conn.commit()
        return ts
    finally:
        conn.rollback()  # no-op after commit; releases the lock on the error paths
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
