"""
NEWQ — a WhatsApp/Telegram-style progressive web app.

Built with the plain Flask framework only — no Flask extensions.
- Database: Python's built-in sqlite3 (see db.py)
- Real-time (messages, typing, presence, WebRTC call signaling): lightweight
  polling of /api/poll, backed by per-user in-memory event queues
- Auth: Flask sessions + werkzeug password hashing (ships with Flask)
"""
import os
import random
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import (Flask, jsonify, redirect, render_template, request,
                   send_from_directory, session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

from config import Config
from db import close_db, execute, init_db, now_iso, query

app = Flask(__name__)
app.config.from_object(Config)
app.teardown_appcontext(close_db)

# ---------------------------------------------------------------------------
# In-memory realtime state (per-process)
# ---------------------------------------------------------------------------
_lock = threading.Lock()
LAST_POLL = {}       # user_id -> unix time of last /api/poll (presence)
EVENT_QUEUES = {}    # user_id -> [ {event, data}, ... ]
QUEUE_CAP = 500      # drop oldest events beyond this per user


def push_event(user_id, event, data):
    """Queue a realtime event for a user; delivered on their next poll."""
    if not user_id:
        return
    with _lock:
        q = EVENT_QUEUES.setdefault(user_id, [])
        q.append({"event": event, "data": data})
        if len(q) > QUEUE_CAP:
            del q[: len(q) - QUEUE_CAP]


def drain_events(user_id):
    with _lock:
        return EVENT_QUEUES.pop(user_id, [])


def is_online(user_id):
    ts = LAST_POLL.get(user_id)
    return ts is not None and (time.time() - ts) < Config.ONLINE_WINDOW_SEC


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    return query("SELECT * FROM users WHERE id = ?", (uid,), one=True)


def login_required_api(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("uid"):
            return jsonify({"error": "Not signed in"}), 401
        return fn(*args, **kwargs)
    return wrapper


def admin_required_api(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = current_user()
        if not user or user["role"] != "admin":
            return jsonify({"error": "Admin access required"}), 403
        return fn(*args, **kwargs)
    return wrapper


def user_dict(row):
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "about": row["about"],
        "avatar": row["avatar"],
        "role": row["role"],
        "online": is_online(row["id"]),
        "last_seen": (row["last_seen"] + "Z") if row["last_seen"] else None,
    }


def user_dict_private(row):
    d = user_dict(row)
    d["created_at"] = row["created_at"] + "Z"
    return d


def msg_dict(row, sender_name=None):
    if sender_name is None:
        s = query("SELECT display_name FROM users WHERE id = ?",
                  (row["sender_id"],), one=True)
        sender_name = s["display_name"] if s else ""
    deleted = bool(row["deleted"])
    return {
        "id": row["id"],
        "sender_id": row["sender_id"],
        "sender_name": sender_name,
        "recipient_id": row["recipient_id"],
        "group_id": row["group_id"],
        "body": "" if deleted else row["body"],
        "media_url": "" if deleted else row["media_url"],
        "media_type": "" if deleted else row["media_type"],
        "media_name": "" if deleted else row["media_name"],
        "created_at": row["created_at"] + "Z",
        "delivered": bool(row["delivered"]),
        "seen": bool(row["seen"]),
        "deleted": deleted,
    }


def group_dict(gid_or_row):
    row = gid_or_row
    if isinstance(gid_or_row, int):
        row = query("SELECT * FROM groups WHERE id = ?", (gid_or_row,), one=True)
    if row is None:
        return None
    members = [r["user_id"] for r in
               query("SELECT user_id FROM group_members WHERE group_id = ?",
                     (row["id"],))]
    return {"id": row["id"], "name": row["name"], "avatar": row["avatar"],
            "created_by": row["created_by"], "members": members}


def contact_rows(user_id):
    return query(
        "SELECT u.* FROM users u JOIN contacts c ON c.contact_id = u.id "
        "WHERE c.user_id = ? ORDER BY u.display_name", (user_id,))


def contact_ids(user_id):
    return [r["contact_id"] for r in
            query("SELECT contact_id FROM contacts WHERE user_id = ?",
                  (user_id,))]


def is_contact(user_id, other_id):
    return query("SELECT 1 FROM contacts WHERE user_id = ? AND contact_id = ?",
                 (user_id, other_id), one=True) is not None


def group_member_ids(group_id):
    return [r["user_id"] for r in
            query("SELECT user_id FROM group_members WHERE group_id = ?",
                  (group_id,))]


def in_group(user_id, group_id):
    return query("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?",
                 (group_id, user_id), one=True) is not None


def classify_extension(ext):
    ext = ext.lower()
    if ext in Config.ALLOWED_IMAGE:
        return "image"
    if ext in Config.ALLOWED_VIDEO:
        return "video"
    if ext in Config.ALLOWED_AUDIO:
        return "audio"
    if ext in Config.ALLOWED_DOCS:
        return "file"
    return None


def save_upload(file_storage, subdir):
    """Save an uploaded file under static/uploads/<subdir>/ with a random name."""
    original = secure_filename(file_storage.filename or "file")
    ext = original.rsplit(".", 1)[-1].lower() if "." in original else ""
    kind = classify_extension(ext)
    if kind is None:
        return None, None, None
    name = f"{uuid.uuid4().hex}.{ext}"
    folder = os.path.join(Config.UPLOAD_ROOT, subdir)
    os.makedirs(folder, exist_ok=True)
    file_storage.save(os.path.join(folder, name))
    return f"/static/uploads/{subdir}/{name}", kind, original


def presence_payload(user_id):
    row = query("SELECT last_seen FROM users WHERE id = ?", (user_id,), one=True)
    return {
        "user_id": user_id,
        "online": is_online(user_id),
        "last_seen": (row["last_seen"] + "Z") if row and row["last_seen"] else None,
    }


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    if not session.get("uid"):
        return redirect(url_for("login_page"))
    return render_template("index.html")


@app.route("/login")
def login_page():
    if session.get("uid"):
        return redirect(url_for("index"))
    return render_template("login.html")


@app.route("/signup")
def signup_page():
    if session.get("uid"):
        return redirect(url_for("index"))
    return render_template("signup.html")


@app.route("/admin")
def admin_page():
    user = current_user()
    if not user:
        return redirect(url_for("login_page"))
    if user["role"] != "admin":
        return redirect(url_for("index"))
    return render_template("admin.html")


@app.route("/manifest.json")
def manifest():
    return send_from_directory("static", "manifest.json",
                               mimetype="application/manifest+json")


@app.route("/sw.js")
def service_worker():
    resp = send_from_directory("static", "sw.js",
                               mimetype="application/javascript")
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp


@app.route("/offline")
def offline_page():
    return render_template("offline.html")


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
@app.route("/api/signup", methods=["POST"])
def api_signup():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip().lower()
    display_name = (data.get("display_name") or "").strip()
    password = data.get("password") or ""

    if not username or not username.replace("_", "").isalnum():
        return jsonify({"error": "Username may only contain letters, numbers and _"}), 400
    if len(username) < 3 or len(username) > 32:
        return jsonify({"error": "Username must be 3–32 characters"}), 400
    if not display_name:
        return jsonify({"error": "Please enter your name"}), 400
    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters"}), 400
    if query("SELECT 1 FROM users WHERE username = ?", (username,), one=True):
        return jsonify({"error": "That username is taken"}), 409

    uid = execute(
        "INSERT INTO users (username, display_name, password_hash, created_at)"
        " VALUES (?, ?, ?, ?)",
        (username, display_name[:64], generate_password_hash(password),
         now_iso()))
    session.permanent = True
    session["uid"] = uid
    user = query("SELECT * FROM users WHERE id = ?", (uid,), one=True)
    return jsonify({"ok": True, "user": user_dict_private(user)})


@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""
    user = query("SELECT * FROM users WHERE username = ?", (username,), one=True)
    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Incorrect username or password"}), 401
    session.permanent = True
    session["uid"] = user["id"]
    return jsonify({"ok": True, "user": user_dict_private(user)})


@app.route("/api/logout", methods=["POST"])
@login_required_api
def api_logout():
    uid = session["uid"]
    execute("UPDATE users SET last_seen = ? WHERE id = ?", (now_iso(), uid))
    with _lock:
        LAST_POLL.pop(uid, None)
        EVENT_QUEUES.pop(uid, None)
    session.clear()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Profile
# ---------------------------------------------------------------------------
@app.route("/api/me", methods=["GET"])
@login_required_api
def api_me():
    return jsonify({"user": user_dict_private(current_user())})


@app.route("/api/me", methods=["PUT"])
@login_required_api
def api_update_me():
    user = current_user()
    data = request.get_json(silent=True) or {}
    if "display_name" in data:
        name = (data["display_name"] or "").strip()
        if not name:
            return jsonify({"error": "Name cannot be empty"}), 400
        execute("UPDATE users SET display_name = ? WHERE id = ?",
                (name[:64], user["id"]))
    if "about" in data:
        execute("UPDATE users SET about = ? WHERE id = ?",
                ((data["about"] or "")[:160], user["id"]))
    if data.get("new_password"):
        if not check_password_hash(user["password_hash"],
                                   data.get("current_password") or ""):
            return jsonify({"error": "Current password is incorrect"}), 400
        if len(data["new_password"]) < 8:
            return jsonify({"error": "New password must be at least 8 characters"}), 400
        execute("UPDATE users SET password_hash = ? WHERE id = ?",
                (generate_password_hash(data["new_password"]), user["id"]))
    fresh = query("SELECT * FROM users WHERE id = ?", (user["id"],), one=True)
    return jsonify({"ok": True, "user": user_dict_private(fresh)})


@app.route("/api/me/avatar", methods=["POST"])
@login_required_api
def api_avatar():
    user = current_user()
    file = request.files.get("avatar")
    if not file:
        return jsonify({"error": "No image received"}), 400
    url, kind, _ = save_upload(file, "avatars")
    if kind != "image":
        return jsonify({"error": "Avatar must be an image (png, jpg, gif, webp)"}), 400
    execute("UPDATE users SET avatar = ? WHERE id = ?", (url, user["id"]))
    return jsonify({"ok": True, "avatar": url})


# ---------------------------------------------------------------------------
# Contacts & chats
# ---------------------------------------------------------------------------
@app.route("/api/contacts")
@login_required_api
def api_contacts():
    uid = session["uid"]
    return jsonify({"contacts": [user_dict(r) for r in contact_rows(uid)]})


@app.route("/api/chats")
@login_required_api
def api_chats():
    uid = session["uid"]
    chats = []

    for contact in contact_rows(uid):
        last = query(
            "SELECT * FROM messages WHERE group_id IS NULL AND "
            "((sender_id = ? AND recipient_id = ?) OR "
            " (sender_id = ? AND recipient_id = ?)) "
            "ORDER BY id DESC LIMIT 1",
            (uid, contact["id"], contact["id"], uid), one=True)
        unread = query(
            "SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND "
            "recipient_id = ? AND seen = 0",
            (contact["id"], uid), one=True)["n"]
        chats.append({
            "type": "direct",
            "peer": user_dict(contact),
            "last_message": msg_dict(last) if last else None,
            "unread": unread,
        })

    memberships = query(
        "SELECT g.*, gm.joined_at AS my_joined_at FROM groups g "
        "JOIN group_members gm ON gm.group_id = g.id WHERE gm.user_id = ?",
        (uid,))
    for g in memberships:
        last = query("SELECT * FROM messages WHERE group_id = ? "
                     "ORDER BY id DESC LIMIT 1", (g["id"],), one=True)
        unread = query(
            "SELECT COUNT(*) AS n FROM messages WHERE group_id = ? AND "
            "sender_id != ? AND created_at >= ? AND seen = 0",
            (g["id"], uid, g["my_joined_at"]), one=True)["n"]
        chats.append({
            "type": "group",
            "group": group_dict(g),
            "last_message": msg_dict(last) if last else None,
            "unread": unread,
        })

    chats.sort(key=lambda c: (c["last_message"] or {}).get("created_at", ""),
               reverse=True)
    return jsonify({"chats": chats})


@app.route("/api/messages")
@login_required_api
def api_messages():
    uid = session["uid"]
    peer_id = request.args.get("peer_id", type=int)
    group_id = request.args.get("group_id", type=int)
    before_id = request.args.get("before", type=int)
    limit = min(request.args.get("limit", 50, type=int), 100)

    if group_id:
        if not in_group(uid, group_id):
            return jsonify({"error": "You are not in this group"}), 403
        sql = "SELECT * FROM messages WHERE group_id = ?"
        args = [group_id]
    elif peer_id:
        if not query("SELECT 1 FROM users WHERE id = ?", (peer_id,), one=True):
            return jsonify({"error": "User not found"}), 404
        sql = ("SELECT * FROM messages WHERE group_id IS NULL AND "
               "((sender_id = ? AND recipient_id = ?) OR "
               " (sender_id = ? AND recipient_id = ?))")
        args = [uid, peer_id, peer_id, uid]
    else:
        return jsonify({"error": "peer_id or group_id required"}), 400

    if before_id:
        sql += " AND id < ?"
        args.append(before_id)
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(limit)
    rows = list(query(sql, args))[::-1]
    return jsonify({"messages": [msg_dict(r) for r in rows]})


@app.route("/api/search")
@login_required_api
def api_search():
    uid = session["uid"]
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify({"results": []})
    gids = [r["group_id"] for r in
            query("SELECT group_id FROM group_members WHERE user_id = ?",
                  (uid,))]
    gid_sql = ("OR group_id IN (%s)" % ",".join("?" * len(gids))) if gids else ""
    rows = query(
        f"SELECT * FROM messages WHERE deleted = 0 AND body LIKE ? AND "
        f"(sender_id = ? OR recipient_id = ? {gid_sql}) "
        f"ORDER BY id DESC LIMIT 40",
        [f"%{q}%", uid, uid] + gids)
    return jsonify({"results": [msg_dict(r) for r in rows]})


# ---------------------------------------------------------------------------
# Media upload
# ---------------------------------------------------------------------------
@app.route("/api/upload", methods=["POST"])
@login_required_api
def api_upload():
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "No file received"}), 400
    forced_kind = request.form.get("kind", "")
    url, kind, original = save_upload(file, "media")
    if not url:
        return jsonify({"error": "File type not allowed"}), 400
    if forced_kind == "voice" and kind == "audio":
        kind = "voice"
    return jsonify({"ok": True, "url": url, "kind": kind, "name": original})


# ---------------------------------------------------------------------------
# Realtime over polling
# ---------------------------------------------------------------------------
@app.route("/api/poll")
@login_required_api
def api_poll():
    """The heartbeat of NEWQ realtime. Clients call this every ~2 seconds
    (faster during calls). Returns queued events, new messages since the
    client's cursor, and a presence snapshot of contacts."""
    uid = session["uid"]
    since = request.args.get("since", type=int)
    init = request.args.get("init") == "1"

    was_offline = not is_online(uid)
    LAST_POLL[uid] = time.time()
    execute("UPDATE users SET last_seen = ? WHERE id = ?", (now_iso(), uid))
    if was_offline:
        for cid in contact_ids(uid):
            push_event(cid, "presence", presence_payload(uid))

    if init or since is None:
        row = query("SELECT MAX(id) AS m FROM messages", one=True)
        return jsonify({
            "events": drain_events(uid),
            "messages": [],
            "cursor": row["m"] or 0,
            "presence": [presence_payload(c) for c in contact_ids(uid)],
            "interval": Config.POLL_INTERVAL_MS,
        })

    gids = [r["group_id"] for r in
            query("SELECT group_id FROM group_members WHERE user_id = ?",
                  (uid,))]
    gid_sql = ("OR group_id IN (%s)" % ",".join("?" * len(gids))) if gids else ""
    rows = query(
        f"SELECT * FROM messages WHERE id > ? AND "
        f"(recipient_id = ? OR sender_id = ? {gid_sql}) "
        f"ORDER BY id ASC LIMIT 100",
        [since, uid, uid] + gids)
    messages = [msg_dict(r) for r in rows]
    cursor = rows[-1]["id"] if rows else since

    # Direct messages to me are now delivered.
    ids = [r["id"] for r in rows
           if r["recipient_id"] == uid and not r["delivered"]]
    if ids:
        execute("UPDATE messages SET delivered = 1 WHERE id IN (%s)"
                % ",".join("?" * len(ids)), ids)

    return jsonify({
        "events": drain_events(uid),
        "messages": messages,
        "cursor": cursor,
        "presence": [presence_payload(c) for c in contact_ids(uid)],
    })


@app.route("/api/messages/send", methods=["POST"])
@login_required_api
def api_send_message():
    user = current_user()
    uid = user["id"]
    data = request.get_json(silent=True) or {}
    body = (data.get("body") or "").strip()
    media_url = data.get("media_url") or ""
    media_type = data.get("media_type") or ""
    media_name = data.get("media_name") or ""
    peer_id = data.get("peer_id")
    group_id = data.get("group_id")

    if not body and not media_url:
        return jsonify({"error": "Empty message"}), 400
    # Only allow media URLs that came from our own upload endpoint.
    if media_url and not media_url.startswith("/static/uploads/"):
        return jsonify({"error": "Invalid media"}), 400

    if group_id:
        if not in_group(uid, group_id):
            return jsonify({"error": "You are not in this group"}), 403
        mid = execute(
            "INSERT INTO messages (sender_id, group_id, body, media_url,"
            " media_type, media_name, created_at, delivered) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
            (uid, group_id, body, media_url, media_type, media_name,
             now_iso()))
    elif peer_id:
        if not is_contact(uid, peer_id):
            return jsonify({"error": "You can only message your contacts."}), 403
        mid = execute(
            "INSERT INTO messages (sender_id, recipient_id, body, media_url,"
            " media_type, media_name, created_at, delivered) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (uid, peer_id, body, media_url, media_type, media_name, now_iso(),
             1 if is_online(peer_id) else 0))
    else:
        return jsonify({"error": "peer_id or group_id required"}), 400

    row = query("SELECT * FROM messages WHERE id = ?", (mid,), one=True)
    return jsonify({"ok": True,
                    "message": msg_dict(row, sender_name=user["display_name"])})


@app.route("/api/typing", methods=["POST"])
@login_required_api
def api_typing():
    user = current_user()
    data = request.get_json(silent=True) or {}
    payload = {"user_id": user["id"], "name": user["display_name"],
               "typing": bool(data.get("typing"))}
    if data.get("group_id"):
        gid = data["group_id"]
        if not in_group(user["id"], gid):
            return jsonify({"ok": False}), 403
        payload["group_id"] = gid
        for mid in group_member_ids(gid):
            if mid != user["id"]:
                push_event(mid, "typing", payload)
    elif data.get("peer_id"):
        payload["peer_id"] = user["id"]
        push_event(data["peer_id"], "typing", payload)
    return jsonify({"ok": True})


@app.route("/api/seen", methods=["POST"])
@login_required_api
def api_seen():
    uid = session["uid"]
    data = request.get_json(silent=True) or {}
    peer_id = data.get("peer_id")
    group_id = data.get("group_id")
    if peer_id:
        execute("UPDATE messages SET seen = 1, delivered = 1 WHERE "
                "sender_id = ? AND recipient_id = ? AND seen = 0",
                (peer_id, uid))
        push_event(peer_id, "messages_seen", {"by": uid, "peer_id": uid})
    elif group_id and in_group(uid, group_id):
        execute("UPDATE messages SET seen = 1 WHERE group_id = ? AND "
                "sender_id != ? AND seen = 0", (group_id, uid))
    return jsonify({"ok": True})


@app.route("/api/messages/delete", methods=["POST"])
@login_required_api
def api_delete_message():
    uid = session["uid"]
    data = request.get_json(silent=True) or {}
    msg = query("SELECT * FROM messages WHERE id = ?",
                (data.get("id", 0),), one=True)
    if not msg or msg["sender_id"] != uid:
        return jsonify({"error": "Message not found"}), 404
    execute("UPDATE messages SET deleted = 1, body = '', media_url = '' "
            "WHERE id = ?", (msg["id"],))
    payload = {"id": msg["id"]}
    if msg["group_id"]:
        for mid in group_member_ids(msg["group_id"]):
            push_event(mid, "message_deleted", payload)
    else:
        push_event(msg["recipient_id"], "message_deleted", payload)
        push_event(msg["sender_id"], "message_deleted", payload)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# WebRTC signaling (relayed through the event queues)
# ---------------------------------------------------------------------------
SIGNAL_EVENTS = {"call_user", "call_answer", "call_decline", "ice_candidate",
                 "call_end", "renegotiate"}


@app.route("/api/signal", methods=["POST"])
@login_required_api
def api_signal():
    user = current_user()
    uid = user["id"]
    data = request.get_json(silent=True) or {}
    event = data.get("event")
    to = data.get("to", 0)
    if event not in SIGNAL_EVENTS:
        return jsonify({"error": "Unknown signal"}), 400

    if event == "call_user":
        if not is_contact(uid, to):
            push_event(uid, "call_failed",
                       {"reason": "You can only call your contacts."})
            return jsonify({"ok": True})
        callee = query("SELECT * FROM users WHERE id = ?", (to,), one=True)
        if not is_online(to):
            execute("INSERT INTO call_logs (caller_id, callee_id, kind,"
                    " started_at, outcome) VALUES (?, ?, ?, ?, 'missed')",
                    (uid, to, data.get("kind", "audio"), now_iso()))
            push_event(uid, "call_failed",
                       {"reason": f"{callee['display_name']} is offline."})
            return jsonify({"ok": True})
        push_event(to, "incoming_call", {
            "from": user_dict(user),
            "kind": data.get("kind", "audio"),
            "offer": data.get("offer"),
            "call_id": data.get("call_id"),
        })
    elif event == "call_answer":
        push_event(to, "call_answered", {
            "from": uid, "answer": data.get("answer"),
            "call_id": data.get("call_id"),
        })
    elif event == "call_decline":
        execute("INSERT INTO call_logs (caller_id, callee_id, kind,"
                " started_at, outcome) VALUES (?, ?, ?, ?, 'declined')",
                (to, uid, data.get("kind", "audio"), now_iso()))
        push_event(to, "call_declined",
                   {"from": uid, "call_id": data.get("call_id")})
    elif event == "ice_candidate":
        push_event(to, "ice_candidate", {
            "from": uid, "candidate": data.get("candidate"),
            "call_id": data.get("call_id"),
        })
    elif event == "call_end":
        duration = int(data.get("duration", 0))
        if data.get("log"):
            execute("INSERT INTO call_logs (caller_id, callee_id, kind,"
                    " started_at, duration_sec, outcome)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (data.get("caller_id") or uid,
                     data.get("callee_id") or to,
                     data.get("kind", "audio"), now_iso(), duration,
                     "answered" if duration > 0 else "missed"))
        push_event(to, "call_ended",
                   {"from": uid, "call_id": data.get("call_id")})
    elif event == "renegotiate":
        push_event(to, "renegotiate", {
            "from": uid, "description": data.get("description"),
            "call_id": data.get("call_id"),
        })
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Groups
# ---------------------------------------------------------------------------
@app.route("/api/groups", methods=["POST"])
@login_required_api
def api_create_group():
    uid = session["uid"]
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    member_ids = data.get("member_ids") or []
    if not name:
        return jsonify({"error": "Group name required"}), 400

    gid = execute("INSERT INTO groups (name, created_by, created_at)"
                  " VALUES (?, ?, ?)", (name[:64], uid, now_iso()))
    execute("INSERT INTO group_members (group_id, user_id, is_admin,"
            " joined_at) VALUES (?, ?, 1, ?)", (gid, uid, now_iso()))
    my_contacts = set(contact_ids(uid))
    for mid in member_ids:
        if mid in my_contacts:
            execute("INSERT OR IGNORE INTO group_members (group_id, user_id,"
                    " joined_at) VALUES (?, ?, ?)", (gid, mid, now_iso()))

    g = group_dict(gid)
    for mid in g["members"]:
        push_event(mid, "group_added", g)
    return jsonify({"ok": True, "group": g})


@app.route("/api/groups/<int:group_id>/members", methods=["POST"])
@login_required_api
def api_add_group_member(group_id):
    uid = session["uid"]
    me = query("SELECT * FROM group_members WHERE group_id = ? AND user_id = ?",
               (group_id, uid), one=True)
    if not me or not me["is_admin"]:
        return jsonify({"error": "Only the group admin can add members"}), 403
    data = request.get_json(silent=True) or {}
    target = query("SELECT * FROM users WHERE id = ?",
                   (data.get("user_id", 0),), one=True)
    if not target:
        return jsonify({"error": "User not found"}), 404
    if in_group(target["id"], group_id):
        return jsonify({"error": "Already a member"}), 409
    execute("INSERT INTO group_members (group_id, user_id, joined_at)"
            " VALUES (?, ?, ?)", (group_id, target["id"], now_iso()))
    g = group_dict(group_id)
    push_event(target["id"], "group_added", g)
    for mid in g["members"]:
        push_event(mid, "group_updated", g)
    return jsonify({"ok": True, "group": g})


@app.route("/api/groups/<int:group_id>/leave", methods=["POST"])
@login_required_api
def api_leave_group(group_id):
    uid = session["uid"]
    if not in_group(uid, group_id):
        return jsonify({"error": "You are not in this group"}), 404
    execute("DELETE FROM group_members WHERE group_id = ? AND user_id = ?",
            (group_id, uid))
    remaining = group_member_ids(group_id)
    if not remaining:
        execute("DELETE FROM groups WHERE id = ?", (group_id,))
    else:
        g = group_dict(group_id)
        for mid in remaining:
            push_event(mid, "group_updated", g)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Connect codes (admin)
# ---------------------------------------------------------------------------
def generate_unique_code():
    for _ in range(200):
        code = f"{random.randint(0, 9999):04d}"
        if not query("SELECT 1 FROM connect_codes WHERE code = ?",
                     (code,), one=True):
            return code
    raise RuntimeError("No free 4-digit codes left")


def code_dict(row):
    redeemers = [r["user_id"] for r in
                 query("SELECT user_id FROM code_redemptions WHERE code_id = ?",
                       (row["id"],))]
    return {"id": row["id"], "code": row["code"],
            "active": bool(row["active"]), "max_uses": row["max_uses"],
            "uses": len(redeemers), "created_at": row["created_at"] + "Z",
            "redeemed_by": redeemers}


@app.route("/api/admin/codes", methods=["POST"])
@admin_required_api
def api_create_code():
    data = request.get_json(silent=True) or {}
    max_uses = max(2, min(int(data.get("max_uses", 10)), 100))
    cid = execute("INSERT INTO connect_codes (code, created_by, created_at,"
                  " max_uses) VALUES (?, ?, ?, ?)",
                  (generate_unique_code(), session["uid"], now_iso(),
                   max_uses))
    row = query("SELECT * FROM connect_codes WHERE id = ?", (cid,), one=True)
    return jsonify({"ok": True, "code": code_dict(row)})


@app.route("/api/admin/codes")
@admin_required_api
def api_list_codes():
    rows = query("SELECT * FROM connect_codes ORDER BY id DESC")
    return jsonify({"codes": [code_dict(r) for r in rows]})


@app.route("/api/admin/codes/<int:code_id>/toggle", methods=["POST"])
@admin_required_api
def api_toggle_code(code_id):
    row = query("SELECT * FROM connect_codes WHERE id = ?", (code_id,),
                one=True)
    if not row:
        return jsonify({"error": "Code not found"}), 404
    execute("UPDATE connect_codes SET active = ? WHERE id = ?",
            (0 if row["active"] else 1, code_id))
    fresh = query("SELECT * FROM connect_codes WHERE id = ?", (code_id,),
                  one=True)
    return jsonify({"ok": True, "code": code_dict(fresh)})


@app.route("/api/admin/users")
@admin_required_api
def api_admin_users():
    rows = query("SELECT * FROM users ORDER BY id DESC")
    return jsonify({"users": [user_dict_private(r) for r in rows]})


@app.route("/api/admin/stats")
@admin_required_api
def api_admin_stats():
    def n(table):
        return query(f"SELECT COUNT(*) AS n FROM {table}", one=True)["n"]
    return jsonify({
        "users": n("users"),
        "online": sum(1 for uid in list(LAST_POLL) if is_online(uid)),
        "messages": n("messages"),
        "groups": n("groups"),
        "codes": n("connect_codes"),
        "calls": n("call_logs"),
    })


@app.route("/api/codes/redeem", methods=["POST"])
@login_required_api
def api_redeem_code():
    """User enters a 4-digit code. Everyone who redeemed the same code becomes
    a mutual contact — they can now chat and call each other."""
    user = current_user()
    uid = user["id"]
    data = request.get_json(silent=True) or {}
    raw = (data.get("code") or "").strip()
    if len(raw) != 4 or not raw.isdigit():
        return jsonify({"error": "Enter the 4-digit code"}), 400
    code = query("SELECT * FROM connect_codes WHERE code = ?", (raw,),
                 one=True)
    if not code or not code["active"]:
        return jsonify({"error": "That code is not valid"}), 404

    redeemers = [r["user_id"] for r in
                 query("SELECT user_id FROM code_redemptions WHERE code_id = ?",
                       (code["id"],))]
    if uid not in redeemers:
        if len(redeemers) >= code["max_uses"]:
            return jsonify({"error": "This code has reached its limit"}), 410
        execute("INSERT INTO code_redemptions (code_id, user_id, redeemed_at)"
                " VALUES (?, ?, ?)", (code["id"], uid, now_iso()))

    new_contacts = []
    for other_id in redeemers:
        if other_id != uid and not is_contact(uid, other_id):
            execute("INSERT OR IGNORE INTO contacts (user_id, contact_id)"
                    " VALUES (?, ?)", (uid, other_id))
            execute("INSERT OR IGNORE INTO contacts (user_id, contact_id)"
                    " VALUES (?, ?)", (other_id, uid))
            other = query("SELECT * FROM users WHERE id = ?", (other_id,),
                          one=True)
            new_contacts.append(other)
            push_event(other_id, "contact_added", user_dict(user))
            push_event(uid, "contact_added", user_dict(other))

    return jsonify({"ok": True,
                    "new_contacts": [user_dict(c) for c in new_contacts]})


# ---------------------------------------------------------------------------
# Status updates (24-hour stories)
# ---------------------------------------------------------------------------
def status_dict(row):
    u = query("SELECT display_name, avatar FROM users WHERE id = ?",
              (row["user_id"],), one=True)
    return {
        "id": row["id"], "user_id": row["user_id"],
        "user_name": u["display_name"] if u else "",
        "avatar": u["avatar"] if u else "",
        "text": row["text"], "media_url": row["media_url"],
        "media_type": row["media_type"],
        "created_at": row["created_at"] + "Z",
    }


@app.route("/api/status", methods=["POST"])
@login_required_api
def api_post_status():
    user = current_user()
    uid = user["id"]
    text, media_url, media_type = "", "", ""
    if request.files.get("file"):
        media_url, media_type, _ = save_upload(request.files["file"], "status")
        if not media_url:
            return jsonify({"error": "File type not allowed"}), 400
        text = (request.form.get("text") or "")[:300]
    else:
        data = request.get_json(silent=True) or {}
        text = (data.get("text") or "").strip()[:300]
        if not text:
            return jsonify({"error": "Write something for your status"}), 400
    sid = execute("INSERT INTO statuses (user_id, text, media_url, media_type,"
                  " created_at) VALUES (?, ?, ?, ?, ?)",
                  (uid, text, media_url, media_type, now_iso()))
    st = status_dict(query("SELECT * FROM statuses WHERE id = ?", (sid,),
                           one=True))
    for cid in contact_ids(uid):
        push_event(cid, "status_new", st)
    return jsonify({"ok": True, "status": st})


@app.route("/api/status/feed")
@login_required_api
def api_status_feed():
    uid = session["uid"]
    cutoff = (datetime.now(timezone.utc).replace(tzinfo=None)
              - timedelta(hours=Config.STATUS_TTL_HOURS)
              ).isoformat(timespec="seconds")
    ids = contact_ids(uid) + [uid]
    rows = query(
        "SELECT * FROM statuses WHERE created_at >= ? AND user_id IN (%s) "
        "ORDER BY id DESC" % ",".join("?" * len(ids)),
        [cutoff] + ids)
    return jsonify({"statuses": [status_dict(r) for r in rows]})


# ---------------------------------------------------------------------------
# Call history
# ---------------------------------------------------------------------------
@app.route("/api/calls")
@login_required_api
def api_calls():
    uid = session["uid"]
    rows = query("SELECT * FROM call_logs WHERE caller_id = ? OR "
                 "callee_id = ? ORDER BY id DESC LIMIT 50", (uid, uid))
    return jsonify({"calls": [{
        "id": r["id"], "caller_id": r["caller_id"],
        "callee_id": r["callee_id"], "kind": r["kind"],
        "started_at": r["started_at"] + "Z",
        "duration_sec": r["duration_sec"], "outcome": r["outcome"],
    } for r in rows]})


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------
init_db()

if __name__ == "__main__":
    print("[NEWQ] Starting on http://0.0.0.0:5000  (plain Flask, threaded)")
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
