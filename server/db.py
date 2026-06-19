"""SQLite storage for GIS users + projects.

Single-file embedded DB (no server / no admin needed). The project blob is the
exact ProjectState JSON the frontend already serializes; we do not decompose
layers into rows (PostGIS decomposition is a future upgrade).
"""
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / "gis.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  google_sub  TEXT UNIQUE NOT NULL,
  email       TEXT NOT NULL,
  name        TEXT,
  picture     TEXT,
  created_at  TEXT NOT NULL,
  last_login  TEXT
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
        conn.commit()
    finally:
        conn.close()


def upsert_user(google_sub: str, email: str, name, picture) -> int:
    conn = get_conn()
    try:
        ts = now_iso()
        row = conn.execute(
            "SELECT id FROM users WHERE google_sub = ?", (google_sub,)
        ).fetchone()
        if row:
            uid = row["id"]
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
