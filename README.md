# NEWQ 💬 — Chat & Calls PWA (plain Flask)

A WhatsApp / Telegram-style progressive web app built with the **plain Python
Flask framework only** — no Flask extensions, no ORM, no socket library.
Frontend is HTML5, CSS3 and vanilla JavaScript.

**The only Python dependency is Flask itself.**

## How realtime works without Socket.IO

The client polls `GET /api/poll` every ~2 seconds (and ~0.7 s during calls).
The server keeps a small in-memory event queue per user and answers each poll
with: queued events (typing, seen receipts, call signaling, new contacts…),
any new chat messages since the client's cursor, and a presence snapshot of
contacts. A user counts as **online** if they polled within the last 10
seconds. WebRTC offers/answers/ICE candidates travel through the same
queues via `POST /api/signal` — once the call connects, audio/video flows
peer-to-peer and no longer touches the server.

## Features

- 🔐 Secure signup / login (hashed passwords, server-side sessions), user & admin roles
- 👤 Profiles with photo, name, about, password change
- 🟢 Live online status, last seen, typing indicators, ✓/✓✓ delivered & seen ticks
- 💬 One-to-one chat and group chat with unread badges
- 😊 Emoji picker, 📎 media sharing (images, video, audio, documents), 🎤 voice notes
- 📞🎥 Voice & video calls over WebRTC with call timer and automatic ICE-restart reconnect
- 🔗 Admin generates unique 4-digit connect codes — everyone who enters the same
  code becomes contacts and can chat & call
- 🔔 Message notifications (local browser notifications while NEWQ runs in a
  background tab or installed PWA)
- ✨ 24-hour status updates (text / photo / video)
- 🔎 Message search across all your chats
- 📲 Installable PWA: manifest, service worker, offline page, install button
  (Android install prompt + iOS "Add to Home Screen" hint)
- 🌗 Glassmorphism UI with dark & light mode, fully responsive

## Quick start

```bash
cd newq
pip install Flask
python app.py
```

Open **http://localhost:5000**

Or use the launchers: `./run.sh` (Linux/macOS) or `run.bat` (Windows).

### Default admin account

| Username | Password |
|---|---|
| `admin` | `Admin@1234` |

**Change this password immediately** (Profile → Change password), or set
`NEWQ_ADMIN_USER` / `NEWQ_ADMIN_PASS` environment variables before first run.

## How connecting works

1. Sign in as **admin** → open `/admin` → **Generate code** (e.g. `4821`).
2. Share the code with the people you want to connect.
3. Each user taps **🔗 Enter code** in the app and types `4821`.
4. Everyone who redeemed the code becomes mutual contacts — they can now
   chat, share media and call each other.

## Important: HTTPS

Browsers only allow **camera/microphone (calls, voice notes), notifications
and PWA install** on `https://` — or on `http://localhost`.

- Local testing on one machine: `http://localhost:5000` works fully.
- Testing from your phone on the same Wi-Fi: use a tunnel that gives you
  HTTPS, e.g. `ngrok http 5000` or Cloudflare Tunnel, and open that URL on
  the phone.
- Production: put the app behind Nginx/Caddy with a TLS certificate
  (Let's Encrypt) and set `NEWQ_HTTPS=1` so session cookies are marked Secure.

## Calls across different networks (TURN)

WebRTC uses STUN by default, which works on most networks. If calls fail to
connect across strict mobile/corporate NATs, add a TURN server in
`static/js/webrtc.js` (`RTC_CONFIG.iceServers`) — e.g. a coturn instance or a
hosted TURN service.

## Production notes

- `python app.py` runs Flask's threaded server — fine for small teams and
  demos. For heavier traffic run it under a WSGI server, e.g.
  `pip install gunicorn` then
  `gunicorn -w 1 --threads 16 -b 0.0.0.0:5000 app:app`.
  Keep **one worker process**: presence and event queues live in process
  memory, so multiple workers would each see only part of the users.
- Set a fixed secret: `export NEWQ_SECRET_KEY=<long random string>` (otherwise
  one is generated and stored in `instance/secret_key.txt`).
- The SQLite database lives at `instance/newq.db`; uploaded media in
  `static/uploads/` — back both up together.

## Project structure

```
newq/
├── app.py                  # Flask app: pages, REST API, polling realtime, signaling
├── db.py                   # sqlite3 schema + tiny query helpers (no ORM)
├── config.py               # configuration (env-overridable)
├── requirements.txt        # just: Flask
├── run.sh / run.bat        # one-command launchers
├── templates/
│   ├── base.html           # shared shell + PWA meta
│   ├── login.html / signup.html
│   ├── index.html          # main chat app
│   ├── admin.html          # admin dashboard (codes, users, stats)
│   └── offline.html        # offline fallback page
├── static/
│   ├── css/app.css         # glassmorphism UI, dark & light themes
│   ├── js/app.js           # chats, media, voice notes, statuses, search, install
│   ├── js/realtime.js      # polling client with Socket.IO-style on/emit API
│   ├── js/webrtc.js        # calls: signaling, timer, reconnect
│   ├── js/notify.js        # local message notifications
│   ├── sw.js               # service worker (offline cache)
│   ├── manifest.json
│   ├── icons/              # generated app icons
│   └── uploads/            # avatars, chat media, status media
└── instance/               # created at runtime: newq.db, secret key
```

## Tech stack

Python 3.10+ · Flask (only) · sqlite3 (standard library) · vanilla
JavaScript · WebRTC · Service Worker + Web App Manifest · CSS custom
properties for theming.
