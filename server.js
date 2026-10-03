// Shadow Hosting — backend
// Manages multiple Python (Telegram bot) processes: start/stop/restart,
// keeps them alive 24/7 (auto-restart on crash with backoff), and streams
// live logs + accepts stdin over a WebSocket "terminal".

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const multer = require("multer");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "hostingnoob00";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const BOTS_DIR = path.join(DATA_DIR, "bots");
const DB_FILE = path.join(DATA_DIR, "bots.json");
const MAX_LOG_LINES = 500;

fs.mkdirSync(BOTS_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]");

function loadBots() {
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
function saveBots(list) {
  fs.writeFileSync(DB_FILE, JSON.stringify(list, null, 2));
}

// in-memory runtime state, keyed by bot id
const runtime = {}; // { proc, status, logs: [], subscribers: Set, restartTimer, manualStop, crashCount }

function getState(id) {
  if (!runtime[id]) {
    runtime[id] = {
      proc: null,
      status: "stopped",
      logs: [],
      subscribers: new Set(),
      restartTimer: null,
      manualStop: false,
      crashCount: 0,
    };
  }
  return runtime[id];
}

function pushLog(id, line) {
  const st = getState(id);
  st.logs.push(line);
  if (st.logs.length > MAX_LOG_LINES) st.logs.shift();
  for (const ws of st.subscribers) {
    try {
      ws.send(JSON.stringify({ type: "log", line }));
    } catch (_) {}
  }
}

function broadcastStatus(id) {
  const st = getState(id);
  for (const ws of st.subscribers) {
    try {
      ws.send(JSON.stringify({ type: "status", status: st.status }));
    } catch (_) {}
  }
}

function botDir(id) {
  return path.join(BOTS_DIR, id);
}

// Python 3 standard library modules — never pip-install these.
const STDLIB = new Set([
  "abc","argparse","array","asyncio","base64","collections","configparser","contextlib",
  "copy","csv","ctypes","dataclasses","datetime","decimal","difflib","enum","errno",
  "functools","glob","hashlib","heapq","hmac","html","http","io","ipaddress","itertools",
  "json","logging","math","mimetypes","multiprocessing","operator","os","pathlib","pickle",
  "platform","pprint","queue","random","re","sched","secrets","select","shutil","signal",
  "site","socket","socketserver","sqlite3","ssl","stat","statistics","string","struct",
  "subprocess","sys","tempfile","textwrap","threading","time","traceback","types",
  "typing","unicodedata","unittest","urllib","uuid","warnings","weakref","xml","zipfile",
  "zlib","__future__",
]);

// Common import-name -> pip-package-name mismatches.
const PACKAGE_ALIASES = {
  telegram: "python-telegram-bot",
  bs4: "beautifulsoup4",
  PIL: "Pillow",
  yaml: "PyYAML",
  cv2: "opencv-python",
  dotenv: "python-dotenv",
  Crypto: "pycryptodome",
  jwt: "PyJWT",
  dateutil: "python-dateutil",
};

function detectImports(code) {
  const names = new Set();
  const re = /^\s*(?:import\s+([a-zA-Z0-9_]+)|from\s+([a-zA-Z0-9_]+)\s+import)/gm;
  let m;
  while ((m = re.exec(code))) {
    const mod = m[1] || m[2];
    if (mod && !STDLIB.has(mod) && mod !== "__future__") names.add(mod);
  }
  return [...names].map((n) => PACKAGE_ALIASES[n] || n);
}

function installRequirements(id, cb) {
  const dir = botDir(id);
  const reqFile = path.join(dir, "requirements.txt");
  let packages = [];

  if (fs.existsSync(reqFile) && fs.readFileSync(reqFile, "utf8").trim() !== "") {
    pushLog(id, "[shadow] requirements.txt found, installing ...");
    return runPip(id, dir, ["install", "--no-cache-dir", "-r", "requirements.txt"], cb);
  }

  // No requirements.txt supplied — auto-detect from the code's imports.
  const mainFile = path.join(dir, "main.py");
  const code = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, "utf8") : "";
  packages = detectImports(code);

  if (packages.length === 0) {
    pushLog(id, "[shadow] no third-party imports detected, skipping install");
    return cb();
  }

  pushLog(id, `[shadow] no requirements.txt — auto-detected: ${packages.join(", ")}`);
  // Save what we detected so it's visible/editable later, and installs are repeatable.
  fs.writeFileSync(reqFile, packages.join("\n") + "\n");
  runPip(id, dir, ["install", "--no-cache-dir", ...packages], cb);
}

function runPip(id, dir, args, cb) {
  const pip = spawn("pip3", args, { cwd: dir });
  pip.stdout.on("data", (d) => pushLog(id, d.toString()));
  pip.stderr.on("data", (d) => pushLog(id, d.toString()));
  pip.on("close", (code) => {
    pushLog(id, `[shadow] pip install exited with code ${code}`);
    cb();
  });
}

function findMissingModule(logs) {
  const text = logs.slice(-15).join("");
  const m = text.match(/ModuleNotFoundError: No module named ['"]([a-zA-Z0-9_]+)/);
  return m ? m[1] : null;
}

function appendRequirement(id, pkg) {
  const reqFile = path.join(botDir(id), "requirements.txt");
  const existing = fs.existsSync(reqFile) ? fs.readFileSync(reqFile, "utf8") : "";
  if (!existing.split("\n").includes(pkg)) {
    fs.writeFileSync(reqFile, existing.trim() + "\n" + pkg + "\n");
  }
}

function startBot(id) {
  const st = getState(id);
  if (st.status === "running" || st.status === "starting") return;
  const dir = botDir(id);
  const entry = path.join(dir, "main.py");
  if (!fs.existsSync(entry)) {
    pushLog(id, "[shadow] error: main.py not found");
    return;
  }
  st.manualStop = false;
  st.status = "starting";
  broadcastStatus(id);

  installRequirements(id, () => {
    pushLog(id, "[shadow] starting bot ...");
    const proc = spawn("python3", ["-u", "main.py"], { cwd: dir, env: process.env });
    st.proc = proc;
    st.status = "running";
    broadcastStatus(id);

    proc.stdout.on("data", (d) => pushLog(id, d.toString()));
    proc.stderr.on("data", (d) => pushLog(id, d.toString()));

    proc.on("close", (code) => {
      pushLog(id, `[shadow] process exited with code ${code}`);
      st.proc = null;
      if (st.manualStop) {
        st.status = "stopped";
        st.crashCount = 0;
        broadcastStatus(id);
        return;
      }

      // If it crashed because a package is missing, install it and retry
      // immediately, without waiting for the normal crash backoff.
      const missing = findMissingModule(st.logs);
      st.fixAttempts = st.fixAttempts || 0;
      if (missing && st.fixAttempts < 5) {
        st.fixAttempts += 1;
        const pkg = PACKAGE_ALIASES[missing] || missing;
        pushLog(id, `[shadow] missing module '${missing}' — installing '${pkg}' and retrying ...`);
        appendRequirement(id, pkg);
        runPip(id, dir, ["install", "--no-cache-dir", pkg], () => startBot(id));
        return;
      }

      // crashed unexpectedly -> auto-restart with backoff (this is the 24/7 behavior)
      st.status = "restarting";
      broadcastStatus(id);
      st.crashCount += 1;
      const delay = Math.min(30000, 2000 * st.crashCount);
      pushLog(id, `[shadow] restarting in ${Math.round(delay / 1000)}s ...`);
      st.restartTimer = setTimeout(() => startBot(id), delay);
    });
  });
}

function stopBot(id) {
  const st = getState(id);
  st.manualStop = true;
  if (st.restartTimer) clearTimeout(st.restartTimer);
  if (st.proc) {
    st.proc.kill("SIGTERM");
  } else {
    st.status = "stopped";
    broadcastStatus(id);
  }
}

function restartBot(id) {
  const st = getState(id);
  if (st.proc) {
    st.manualStop = true; // close handler will see manualStop then we flip it
    st.proc.once("close", () => {
      st.manualStop = false;
      startBot(id);
    });
    st.proc.kill("SIGTERM");
  } else {
    startBot(id);
  }
}

// ---------- HTTP API ----------

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const sessions = new Set(); // simple in-memory tokens

function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "") || req.query.token;
  if (token && sessions.has(token)) return next();
  return res.status(401).json({ error: "unauthorized" });
}

app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "wrong password" });
  }
  const token = crypto.randomBytes(24).toString("hex");
  sessions.add(token);
  res.json({ token });
});

app.get("/api/bots", auth, (req, res) => {
  const bots = loadBots().map((b) => ({
    ...b,
    status: getState(b.id).status,
  }));
  res.json(bots);
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.post("/api/bots", auth, upload.single("file"), (req, res) => {
  const { name, requirements } = req.body;
  if (!name || !req.file) return res.status(400).json({ error: "name and .py file required" });
  const id = crypto.randomBytes(6).toString("hex");
  const dir = botDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main.py"), req.file.buffer);
  if (requirements) fs.writeFileSync(path.join(dir, "requirements.txt"), requirements);

  const bots = loadBots();
  bots.push({ id, name, autostart: true, createdAt: Date.now() });
  saveBots(bots);
  getState(id); // init runtime slot
  res.json({ id });
});

app.post("/api/bots/:id/start", auth, (req, res) => {
  startBot(req.params.id);
  res.json({ ok: true });
});
app.post("/api/bots/:id/stop", auth, (req, res) => {
  stopBot(req.params.id);
  res.json({ ok: true });
});
app.post("/api/bots/:id/restart", auth, (req, res) => {
  restartBot(req.params.id);
  res.json({ ok: true });
});

app.delete("/api/bots/:id", auth, (req, res) => {
  const id = req.params.id;
  stopBot(id);
  let bots = loadBots();
  bots = bots.filter((b) => b.id !== id);
  saveBots(bots);
  fs.rmSync(botDir(id), { recursive: true, force: true });
  delete runtime[id];
  res.json({ ok: true });
});

app.post("/api/bots/:id/autostart", auth, (req, res) => {
  const { autostart } = req.body;
  const bots = loadBots();
  const b = bots.find((x) => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: "not found" });
  b.autostart = !!autostart;
  saveBots(bots);
  res.json({ ok: true });
});

// ---------- WebSocket terminal ----------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");
  const id = url.searchParams.get("id");
  if (!token || !sessions.has(token) || !id) {
    ws.close();
    return;
  }
  const st = getState(id);
  st.subscribers.add(ws);
  // replay recent logs
  ws.send(JSON.stringify({ type: "backlog", lines: st.logs, status: st.status }));

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === "stdin" && st.proc && st.proc.stdin.writable) {
        st.proc.stdin.write(data.data);
      }
    } catch (_) {}
  });

  ws.on("close", () => st.subscribers.delete(ws));
});

// auto-start bots flagged autostart on boot
for (const b of loadBots()) {
  if (b.autostart) startBot(b.id);
}

server.listen(PORT, () => {
  console.log(`Shadow Hosting listening on :${PORT}`);
});
