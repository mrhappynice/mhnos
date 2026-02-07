# MHNOS External Runtime Guide

This guide explains how to use the **MHNOS Workerd Runtime** - an external Docker container that runs Node.js, Python, and Workerd processes with full system isolation.

## What is the External Runtime?

The external runtime is a Docker container that provides:
- **Full Node.js 22+** with native module support
- **Workerd** (Cloudflare Workers runtime)
- **Python 3** with pip
- **Bash shells** with PTY support
- **Process isolation** from your host system
- **Optional OpenClaw** AI agent framework

Unlike the in-browser workers, this runtime can:
- Spawn child processes
- Use native Node.js modules
- Run OpenClaw/Moltbot AI agents
- Execute shell commands

---

## Quick Start

### 1. Start the Runtime

```bash
cd /workspace/runtime

# Basic runtime (Node.js + Workerd)
docker-compose up -d

# Or with OpenClaw support
docker-compose --profile openclaw up -d
```

### 2. Verify it's Running

```bash
curl http://localhost:18790/health
```

### 3. Connect from MHNOS

In the MHNOS shell:
```bash
runtime connect ws://localhost:18790
```

You should see: `[Runtime] Connected to external runtime`

---

## File Sharing (Volume Mount)

The runtime uses a **shared folder** approach:

**On your computer:** Files in `~/mhnos-workspace` (or wherever you mounted)  
**In the container:** Files appear at `/workspace`

### docker-compose.yml Setup

```yaml
volumes:
  - ~/mhnos-workspace:/workspace  # Change this path as needed
```

### Workflow

1. **Upload to Web OS**: Use `upload` command → files go to OPFS
2. **Export to shared folder**: Use `backup` command → files go to `~/mhnos-workspace`
3. **Runtime sees files**: Container accesses `/workspace`
4. **Runtime writes files**: Appears in `~/mhnos-workspace`
5. **Import to Web OS**: Use `upload` from `~/mhnos-workspace` → back to OPFS

---

## Commands Reference

### Runtime Management

| Command | Description |
|---------|-------------|
| `runtime status` | Check connection and runtime info |
| `runtime connect [url]` | Connect to runtime (default: ws://localhost:18790) |
| `runtime disconnect` | Disconnect from runtime |
| `runtime list` | List running runtime processes |

### Process Spawning

| Command | Description |
|---------|-------------|
| `runtime spawn node <script.js> [args]` | Run Node.js script |
| `runtime spawn python <script.py> [args]` | Run Python script |
| `runtime spawn workerd <config.capnp>` | Run Workerd with config |
| `rshell` | Spawn interactive bash shell |
| `workerd <config.capnp>` | Quick workerd spawn |

### Process Control

| Command | Description |
|---------|-------------|
| `runtime kill <pid>` | Kill a runtime process |
| `runtime attach <pid>` | Attach shell to process output |
| `term --runtime <pid>` | Open terminal window for process |

### File Sync (Alternative to Volume Mount)

| Command | Description |
|---------|-------------|
| `fsync status` | Check sync status |
| `fsync push` | Push OPFS files to runtime (slower) |
| `fsync pull` | Pull runtime files to OPFS (slower) |

> **Note:** `fsync` sends files through WebSocket. For large files, use the volume mount approach instead.

### OpenClaw (if enabled in container)

| Command | Description |
|---------|-------------|
| `openclaw status` | Check if OpenClaw is available |
| `openclaw start` | Start OpenClaw gateway |
| `openclaw attach` | Attach terminal to OpenClaw |

---

## Usage Examples

### Example 1: Run a Node.js Script

```bash
# In MHNOS, create a script
edit /myapp/hello.js
```

Content:
```javascript
console.log("Hello from external runtime!");
console.log("Node version:", process.version);
console.log("Working directory:", process.cwd());
```

Save and export:
```bash
# Export to shared folder (~/mhnos-workspace)
backup export /myapp
```

Spawn in runtime:
```bash
runtime connect
runtime spawn node /workspace/hello.js
```

### Example 2: Interactive Shell Session

```bash
# Connect to runtime
runtime connect

# Spawn a bash shell
rshell
# Note the PID output, e.g., "[Runtime Shell 1000] Started"

# Attach terminal
term --runtime 1000
```

Now you have a full bash shell! Install packages, run commands, etc.:
```bash
npm install express
node -e "console.log('Hello')"
```

### Example 3: Run OpenClaw

With OpenClaw-enabled container:

```bash
# Start OpenClaw gateway
openclaw start

# Attach to see output
openclaw attach
```

Or manually:
```bash
rshell
runtime list  # Get PID
term --runtime <pid>

# In the shell:
openclaw gateway --config /workspace/openclaw-config.json
```

### Example 4: Workerd Configuration

Create a workerd config in your shared folder (`~/mhnos-workspace/app.capnp`):

```capnp
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "main", worker = .worker)],
  sockets = [(name = "http", address = "127.0.0.1:8080", http = (), service = "main")]
);

const worker :Workerd.Worker = (
  compatibilityDate = "2025-01-01",
  compatibilityFlags = ["nodejs_compat"],
  modules = [(name = "main", esModule = embed "app.js")]
);
```

Create `~/mhnos-workspace/app.js`:
```javascript
export default {
  async fetch(request) {
    return new Response("Hello from Workerd!");
  }
}
```

Run in MHNOS:
```bash
runtime connect
workerd /workspace/app.capnp
```

---

## Container Variants

### Standard Runtime
- Node.js 22+
- Workerd
- Python 3
- Bash

```bash
docker-compose up -d
```

### OpenClaw Runtime
- Everything in standard
- Plus OpenClaw AI agent framework
- Requires more memory (8GB recommended)

```bash
docker-compose --profile openclaw up -d mhnos-runtime-openclaw
```

Connects on port **18791** instead of 18790.

---

## Troubleshooting

### Connection Refused

```bash
# Check if container is running
docker ps | grep mhnos

# Check logs
docker logs mhnos-runtime

# Restart
docker-compose restart
```

### Permission Denied on Volume

Make sure the mounted folder is writable:
```bash
chmod 777 ~/mhnos-workspace
```

### OpenClaw Not Found

You need the OpenClaw profile:
```bash
docker-compose --profile openclaw up -d mhnos-runtime-openclaw
runtime connect ws://localhost:18791
```

### Process Spawn Fails

Check available commands in runtime:
```bash
rshell
which node
which python3
which workerd
which openclaw  # If enabled
```

### High Memory Usage

The OpenClaw container uses significant memory. Adjust in `docker-compose.yml`:

```yaml
deploy:
  resources:
    limits:
      memory: 8G  # Adjust as needed
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Your Computer                           │
│  ┌──────────────────┐          ┌──────────────────────────┐ │
│  │  Web OS (Browser)│          │  Docker Container        │ │
│  │                  │          │  ┌────────────────────┐  │ │
│  │  OPFS (files)    │◄────────►│  │  Node.js 22+       │  │ │
│  │  Shell/Terminal  │ WebSocket│  │  Workerd           │  │ │
│  │                  │          │  │  Python            │  │ │
│  └──────────────────┘          │  │  OpenClaw (opt)    │  │ │
│           │                    │  └────────────────────┘  │ │
│           │ Backup/Upload      │           │              │ │
│           ▼                    │           ▼              │ │
│  ┌──────────────────┐          │  ┌────────────────────┐  │ │
│  │  ~/mhnos-workspace│◄────────►│  │  /workspace        │  │ │
│  │  (Shared Folder)  │ Volume   │  │  (Container FS)    │  │ │
│  └──────────────────┘          │  └────────────────────┘  │ │
│                                └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Building Custom Runtime

To add your own tools to the runtime:

1. Edit `runtime/Dockerfile`
2. Add your packages:
   ```dockerfile
   RUN apt-get install -y your-package
   RUN npm install -g your-tool
   ```
3. Rebuild:
   ```bash
   docker-compose build --no-cache
   docker-compose up -d
   ```

---

## Security Notes

- Runtime runs as non-root user (`mhnos`)
- Container has read-only root filesystem
- Network access is restricted to WebSocket port
- Volume mount only exposes the workspace folder
- For production, consider additional sandboxing

---

## Next Steps

- Try running OpenClaw AI agents
- Experiment with Workerd configurations
- Build custom tools in the runtime
- Share files between Web OS and runtime via volume mount

For issues or questions, check the runtime logs:
```bash
docker logs -f mhnos-runtime
```
