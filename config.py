"""NEWQ configuration — plain Flask, no extensions."""
import os
import secrets

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, "instance")
os.makedirs(INSTANCE_DIR, exist_ok=True)

# Persist a stable SECRET_KEY across restarts so sessions survive.
_secret_path = os.path.join(INSTANCE_DIR, "secret_key.txt")
if os.environ.get("NEWQ_SECRET_KEY"):
    _SECRET = os.environ["NEWQ_SECRET_KEY"]
elif os.path.exists(_secret_path):
    with open(_secret_path) as f:
        _SECRET = f.read().strip()
else:
    _SECRET = secrets.token_hex(32)
    with open(_secret_path, "w") as f:
        f.write(_SECRET)


class Config:
    SECRET_KEY = _SECRET
    DATABASE = os.path.join(INSTANCE_DIR, "newq.db")

    UPLOAD_ROOT = os.path.join(BASE_DIR, "static", "uploads")
    MAX_CONTENT_LENGTH = 32 * 1024 * 1024  # 32 MB uploads

    ALLOWED_IMAGE = {"png", "jpg", "jpeg", "gif", "webp"}
    ALLOWED_VIDEO = {"mp4", "webm", "mov", "m4v"}
    ALLOWED_AUDIO = {"mp3", "wav", "ogg", "webm", "m4a", "aac", "opus"}
    ALLOWED_DOCS = {"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "zip", "csv"}

    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = os.environ.get("NEWQ_HTTPS", "0") == "1"

    # Default admin seeded on first run (change the password after first login).
    DEFAULT_ADMIN_USERNAME = os.environ.get("NEWQ_ADMIN_USER", "admin")
    DEFAULT_ADMIN_PASSWORD = os.environ.get("NEWQ_ADMIN_PASS", "Admin@1234")

    STATUS_TTL_HOURS = 24
    ONLINE_WINDOW_SEC = 10   # seen a poll within this window => online
    POLL_INTERVAL_MS = 2000  # client poll cadence (informational)
