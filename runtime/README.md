# MHNOS Workerd Runtime

External runtime service for MHNOS Web OS that provides isolated execution of Node.js, Python, and Workerd processes.

## Quick Start

### Using Docker (Recommended)

```bash
# Build and run
docker-compose up -d

# Check status
curl http://localhost:18790/health

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

### With OpenClaw Support

```bash
# Build with OpenClaw
docker-compose --profile openclaw up -d mhnos-runtime-openclaw

# This starts on port 18791
```

### Native Installation

```bash
# Requirements: Node.js 22+, workerd binary
./install.sh

# Start
npm start
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MHNOS_RUNTIME_PORT` | 18790 | WebSocket port for browser connection |
| `MHNOS_WORKSPACE` | /workspace | Working directory for processes |
| `MHNOS_SANDBOX` | strict | Sandbox mode: strict, relaxed, none |
| `MHNOS_ALLOW_OPENCLAW` | false | Enable OpenClaw support |
| `MHNOS_MAX_PROCESSES` | 50 | Maximum concurrent processes |
| `MHNOS_MAX_MEMORY` | 1g | Max memory per process |
| `MHNOS_LOG_LEVEL` | info | Log level: debug, info, warn, error |

## WebSocket Protocol

### Connection

Connect to `ws://localhost:18790`

### Messages

#### Spawn a Process

```json
{
  "type": "spawn",
  "id": "request-123",
  "processType": "node",
  "command": "/workspace/script.js",
  "args": ["--port", "3000"],
  "options": {
    "cwd": "/workspace",
    "env": { "NODE_ENV": "production" },
    "timeout": 0
  }
}
```

Process types: `node`, `workerd`, `shell`, `python`, `openclaw`

#### Attach to Process

```json
{
  "type": "attach",
  "id": "request-124",
  "pid": 1000
}
```

#### Write to Process stdin

```json
{
  "type": "write",
  "pid": 1000,
  "data": "hello\n"
}
```

#### Kill Process

```json
{
  "type": "kill",
  "id": "request-125",
  "pid": 1000,
  "signal": "SIGTERM"
}
```

#### List Processes

```json
{
  "type": "list",
  "id": "request-126"
}
```

Response:

```json
{
  "type": "processList",
  "id": "request-126",
  "processes": [
    {
      "pid": 1000,
      "type": "node",
      "command": "/workspace/script.js",
      "startTime": 1234567890,
      "status": "running"
    }
  ],
  "stats": {
    "totalSpawned": 1,
    "totalKilled": 0,
    "active": 1
  }
}
```

### Server → Client Messages

#### Process Output

```json
{
  "type": "stdout",
  "pid": 1000,
  "data": "Hello World\n"
}
```

#### Process Exit

```json
{
  "type": "exit",
  "pid": 1000,
  "code": 0,
  "signal": null,
  "runtime": 5000
}
```

## Architecture

```
┌─────────────────┐      WebSocket       ┌──────────────────┐
│   MHNOS Web OS  │ ◄──────────────────► │  Runtime Bridge  │
│   (Browser)     │    ws://localhost    │   (this server)  │
└─────────────────┘       :18790         └────────┬─────────┘
                                                   │
                              ┌────────────────────┼────────────────────┐
                              ▼                    ▼                    ▼
                        ┌─────────┐         ┌──────────┐         ┌──────────┐
                        │ Node.js │         │ Workerd  │         │  Shell   │
                        │ Process │         │ Process  │         │  (PTY)   │
                        └─────────┘         └──────────┘         └──────────┘
```

## Security

- Runs as non-root user inside container
- Read-only root filesystem
- Resource limits (CPU, memory)
- Sandboxed environment variables
- Path traversal protection
- Capability dropping

## Development

```bash
# Install dependencies
npm install

# Run in dev mode (auto-reload)
npm run dev

# Run tests
npm test

# Build Docker image
npm run docker:build
```

## License

MIT
