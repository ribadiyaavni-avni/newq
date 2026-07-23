"""NEWQ database layer — plain sqlite3, no ORM, no Flask extensions."""
import sqlite3
from datetime import datetime, timezone

from flask import g

from config import Config

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT DEFAULT 'user',
    about         TEXT DEFAULT 'Hey there! I am using NEWQ.',
    avatar        TEXT DEFAULT '',
    last_seen     TEXT,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
    user_id    INTEGER NOT NULL,
    contact_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, contact_id)
);

CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    avatar     TEXT DEFAULT '',
    created_by INTEGER,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
    group_id  INTEGER NOT NULL,
    user_id   INTEGER NOT NULL,
    is_admin  INTEGER DEFAULT 0,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id    INTEGER NOT NULL,
    recipient_id INTEGER,
    group_id     INTEGER,
    body         TEXT DEFAULT '',
    media_url    TEXT DEFAULT '',
    media_type   TEXT DEFAULT '',
    media_name   TEXT DEFAULT '',
    created_at   TEXT NOT NULL,
    delivered    INTEGER DEFAULT 0,
    seen         INTEGER DEFAULT 0,
    deleted      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_pair  ON messages (sender_id, recipient_id, id);
CREATE INDEX IF NOT EXISTS idx_msg_group ON messages (group_id, id);

CREATE TABLE IF NOT EXISTS connect_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT UNIQUE NOT NULL,
    created_by INTEGER,
    created_at TEXT NOT NULL,
    active     INTEGER DEFAULT 1,
    max_uses   INTEGER DEFAULT 10
);

CREATE TABLE IF NOT EXISTS code_redemptions (
    code_id     INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    redeemed_at TEXT NOT NULL,
    PRIMARY KEY (code_id, user_id)
);

CREATE TABLE IF NOT EXISTS statuses (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    text       TEXT DEFAULT '',
    media_url  TEXT DEFAULT '',
    media_type TEXT DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_time ON statuses (created_at);

CREATE TABLE IF NOT EXISTS call_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    caller_id    INTEGER NOT NULL,
    callee_id    INTEGER NOT NULL,
    kind         TEXT DEFAULT 'audio',
    started_at   TEXT NOT NULL,
    duration_sec INTEGER DEFAULT 0,
    outcome      TEXT DEFAULT 'missed'
);
"""


def now_iso():
    """UTC timestamp, second precision, sortable, e.g. 2026-07-22T10:30:00."""
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds")


def get_db():
    """One connection per request, stored on flask.g."""
    if "db" not in g:
        g.db = sqlite3.connect(Config.DATABASE)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    """Create tables and seed the default admin account."""
    conn = sqlite3.connect(Config.DATABASE)
    conn.executescript(SCHEMA)
    cur = conn.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1")
    if cur.fetchone() is None:
        from werkzeug.security import generate_password_hash
        conn.execute(
            "INSERT INTO users (username, display_name, password_hash, role,"
            " about, created_at) VALUES (?, ?, ?, 'admin', ?, ?)",
            (Config.DEFAULT_ADMIN_USERNAME, "NEWQ Admin",
             generate_password_hash(Config.DEFAULT_ADMIN_PASSWORD),
             "NEWQ administrator", now_iso()),
        )
        conn.commit()
        print(f"[NEWQ] Seeded admin account: {Config.DEFAULT_ADMIN_USERNAME} / "
              f"{Config.DEFAULT_ADMIN_PASSWORD} — change this password!")
    conn.close()


# ---------------------------------------------------------------------------
# Tiny query helpers
# ---------------------------------------------------------------------------
def query(sql, args=(), one=False):
    cur = get_db().execute(sql, args)
    rows = cur.fetchall()
    return (rows[0] if rows else None) if one else rows


def execute(sql, args=()):
    """Run a write statement and commit. Returns lastrowid."""
    db = get_db()
    cur = db.execute(sql, args)
    db.commit()
    return cur.lastrowid


def executemany(sql, seq):
    db = get_db()
    db.executemany(sql, seq)
    db.commit()
