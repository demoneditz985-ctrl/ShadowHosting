# Shadow Hosting

A small control panel for running several Python Telegram bots at once, each isolated,
with a live web terminal and automatic restart if a bot crashes (your "24/7").

## What's inside
- `server.js` — Node/Express backend. Spawns each bot as `python3 main.py`,
  auto-restarts it on crash (with backoff), installs `requirements.txt` per bot,
  and streams logs/stdin over a WebSocket.
- `public/index.html` — the dashboard (login, bot list, terminal, add/start/stop/restart/delete).
- `Dockerfile` — Node 20 + Python3/pip, so bots can actually run on Render.
- `render.yaml` — Render Blueprint: a Docker web service with a 1GB persistent disk.

## Deploy on Render
1. Push this folder to a GitHub repo.
2. In Render: **New → Blueprint**, point it at the repo (it reads `render.yaml` automatically).
   - It provisions a Docker web service + a persistent disk mounted at `/data`
     (without this disk, uploaded bots would be wiped on every redeploy).
3. Render will ask for the `ADMIN_PASSWORD` env var — set it to whatever you want
   the panel's login password to be.
4. Deploy. Open the URL Render gives you, log in, click **+ Add bot**, paste your
   bot's Python code (and any pip requirements), and it starts automatically.

If you'd rather not use the Blueprint, you can create the service manually: choose
**Docker** as the runtime, add the same `ADMIN_PASSWORD` env var, and attach a disk
at `/data` with `DATA_DIR=/data`.

## Running locally
```bash
npm install
ADMIN_PASSWORD=mypassword node server.js
# open http://localhost:3000
```
(Needs `python3` and `pip3` on your machine to actually run bots locally.)

## Auto-installing modules
You don't have to supply a `requirements.txt`. When you add a bot without one,
the server scans `main.py` for its `import` / `from ... import` statements, drops
anything from the Python standard library, maps a few known mismatches
(`telegram` → `python-telegram-bot`, `bs4` → `beautifulsoup4`, `PIL` → `Pillow`, etc.),
and `pip install`s the rest before starting the bot — then saves what it installed
into `requirements.txt` for next time. If a bot still crashes with
`ModuleNotFoundError` (e.g. a package whose pip name can't be guessed from the
import name), the server installs that exact module and retries automatically,
up to 5 times per bot. You can always override this by pasting your own
`requirements.txt` in the "Add bot" form — that takes priority.

## How "24/7" works here
Each bot runs as a plain child process. If it exits on its own (crash, exception),
the server waits a short, increasing delay and restarts it automatically — it keeps
doing this until you hit **Stop**. This is process-level reliability, not magic:
if the whole Render service restarts (e.g. a deploy), bots flagged `autostart`
(the default) are started again when the server boots.

## Limitations, honestly
- This is a single-server panel: all bots share one machine's CPU/RAM. Fine for a
  handful of small bots; not meant for dozens of heavy ones.
- No per-bot resource limits or sandboxing beyond separate OS processes — only add
  bots you trust, since their Python code runs with the same permissions as the server.
- The web terminal shows stdout/stderr and lets you send stdin; it's not a full PTY shell.
- Multer uploads cap at 5MB per file; raise `limits.fileSize` in `server.js` if needed.

## Security notes
- Change `ADMIN_PASSWORD` to something strong — anyone with it can upload and run
  arbitrary Python on your server.
- Sessions are simple in-memory tokens; they reset if the server restarts (you'll
  need to log in again), which is fine for a single-admin panel.
