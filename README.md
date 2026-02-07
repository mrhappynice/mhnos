# MHNOS Web OS

## Welcome to **MHNOS** — an **isolated, in-browser dev environment** that feels like a tiny operating system:

## TL;DR

MHNOS is a **mini dev OS in your browser**:

- persistent filesystem
- shell + scripts
- JS + Python processes
- npm installs
- app scaffolding + bundling
- Packedit for build/serve/export
- optional Rust WS proxy for real networking + TCP
- **External Runtime** - Run Node.js 22+, Workerd, Python, and OpenClaw AI in isolated Docker containers

It’s designed to be friendly and fun: you can learn by doing, without installing a giant toolchain first.

## Why this exists

Modern dev stacks are powerful, but they’re also heavy. MHNOS flips the script:

- Your workspace lives in the browser (persisted in OPFS).
- Your code runs in isolated workers (safer, cleaner, less “it broke my machine”).
- You can build + bundle + export projects right here.
- You can run Node-ish scripts (Express-style demos included).
- You can run Python (Pyodide-based) and read/write files inside the same OS filesystem.

## Mental model

### “Disk”

Your “disk” is the browser’s **Origin Private File System (OPFS)**. It persists between refreshes.

### “Processes”

When you `run` code, MHNOS launches a **Worker process** and tracks it with a PID. The OS can list processes and attach a TTY.

### “Apps”

Apps are windows. Some are utilities (Files, Browser, Launcher), some are dev tools (Packedit), and you can scaffold your own apps (oapp).

## Getting around

The shell prompt shows your current working directory:

user@mhnos:/somewhere$

Basics:

- `pwd` prints the working directory

- `ls` lists files

- `cd` moves

- `cat` prints a file

- `mkdir`, `rm`, `cp` do what you expect

---

## Shell commands

Run `help` in MHNOS for the canonical list.

### Files + editing

- `edit <file>` — open the editor (quick edits + save)

- `md <file>` — open markdown preview

- `upload [folder|-r]` — upload files/folders into OPFS

### Running code + processes

- `run <file>` — run a JS process in a worker

- `ps` — list running processes

- `kill <pid>` — kill a process

### TTY + Terminal windows

MHNOS supports attaching a “TTY” stream to a process and viewing it in a terminal window:

- `tty status`

- `tty attach <pid>`

- `tty detach`

Open a full terminal UI:

- `term <pid>`

### Command scripts (.cmds)

You can execute a file full of shell commands:

- `cmd <file>` — reads a file, strips comments/blank lines, and runs commands line-by-line

Example included:

- `demos/install-react.cmds` installs React + ReactDOM globally via `npm install -g ...`

### Python

MHNOS can spawn Python processes:

- `python <file.py>`

- `python -c <code>`

Under the hood:

- Python runs in a dedicated worker using **Pyodide**

- Loaded from `/vendor/pyodide/full/pyodide.js`

- Index URL `/vendor/pyodide/full/`

- OPFS is mounted at `/opfs`

- The process `chdir`s to `/opfs` by default

- Interactive input is supported via buffered TTY lines for `input()`

### oapp: your “make an app” workflow

`oapp` is the built-in app runner + scaffolder:

- `oapp <path>` — launch an app

- `oapp init [path]` — scaffold a Vite-style React app

- `oapp build [path]` — bundle to `dist/`

`oapp init` creates:

- `index.html`

- `src/main.tsx`

- `src/App.tsx`

- `src/styles.css`

`oapp build`:

- reads `index.html`

- finds your entry module

- bundles with esbuild

- copies non-src assets into `dist/`

- writes bundled assets into `dist/assets`

### npm (package installs inside Web OS)

MHNOS includes a PackageManager exposed through:

- `npm install <package|package.json> [-g|--global]`

Convenience helper:

- `serverhere` — copies `/demos/site/server.js` into your cwd and installs express

### Networking controls (direct vs proxy)

Network modes:

- `direct` — normal fetch when allowed

- `proxy` — WebSocket proxy for fetch + raw TCP

- `worker` — placeholder (not fully implemented)

Shell controls:

- `net status`

- `net mode <direct|proxy|worker>`

- `net proxy <ws-url>`

**Important:** TCP requires proxy mode.

---

## Packedit (the “build/export” editor)

**Packedit** is a project editor built into MHNOS — meant for “open a folder and ship something”.

It includes:

- project picker

- file tree (skips `node_modules`, `dist`, `.git`, `.cache`)

- editor pane

- live preview iframe

- action buttons: **Build**, **Serve**, **Zip dist**, **Save**

If your goal is:

- build a project

- preview it

- export a distributable (zip)

Packedit is the “do it all from one window” path.

---

## Running servers inside MHNOS

MHNOS can run “Node-ish” server scripts inside worker processes (demo uses Express).

Quick path:

```sh
mkdir /projects
cd /projects
serverhere
run server.js
```

Then open `browser` and visit `localhost:3000`.

---

## The WS Rust proxy (for “real internet” + TCP sockets)

Browsers restrict networking (CORS, raw TCP). MHNOS supports a **WebSocket proxy mode** that unlocks:

- proxied `fetch`

- raw TCP streams

Defaults:

- Proxy listens on `ws://127.0.0.1:5772`

- MHNOS default proxy URL is `ws://localhost:5772`

Usage:

1. Build/run the Rust proxy from `servers/ws-proxy-rust/`

2. In MHNOS:
   
   - `net mode proxy`
   
   - `net proxy ws://localhost:5772`

3. Confirm with `net status`

---

## External Runtime (Workerd/OpenClaw)

MHNOS can connect to an **external runtime** running in a Docker container. This provides:

- **Full Node.js 22+** with native modules
- **Workerd** (Cloudflare Workers runtime)
- **Python 3**
- **OpenClaw/Moltbot** AI agent framework
- Real process isolation

### Quick Start

```bash
# Start the runtime
cd runtime
docker-compose up -d

# Connect from MHNOS
runtime connect
```

### File Sharing

The runtime uses a **shared folder** (`~/mhnos-workspace` by default):

1. Upload files to Web OS
2. Export to shared folder: `backup export /myproject`
3. Runtime sees files at `/workspace`
4. Runtime writes files → appears in shared folder
5. Import back to Web OS: `upload`

### Key Commands

| Command | Description |
|---------|-------------|
| `runtime connect` | Connect to runtime container |
| `rshell` | Spawn bash shell in runtime |
| `runtime spawn node app.js` | Run Node.js script |
| `openclaw start` | Start OpenClaw AI agent |
| `term --runtime <pid>` | Attach terminal to process |

See `demos/README.md` for detailed documentation.

---

---
