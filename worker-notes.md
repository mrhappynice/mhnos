/workspace/runtime/
  ├── Dockerfile                    # Multi-stage Docker build
  ├── docker-compose.yml            # Docker Compose with security hardening
  ├── package.json                  # Node.js dependencies (ws, @lydell/node-pty)
  ├── server.js                     # Main WebSocket bridge server (~600 lines)
  ├── install.sh                    # Native systemd installation script
  ├── README.md                     # Documentation
  ├── IMPLEMENTATION_STATUS.md      # Implementation status
  ├── test-client.js                # Simple test client
  ├── .dockerignore
  └── templates/
      ├── default.capnp            # Basic Workerd config
      └── nodejs-compat.capnp      # Full Node.js compatibility config


Key Features

   Feature              Implementation
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Process Types        node, workerd, shell (PTY), python, openclaw
   WebSocket Protocol   JSON-based with request/response correlation
   Security             Non-root user, read-only fs, resource limits, sandboxed env
   Process Management   Spawn, attach, kill, resize TTY, output buffering
   Health Check         HTTP endpoint at /health

  Quick Start

  # Build and run with Docker
  cd /workspace/runtime
  docker build -t mhnos/runtime .
  docker run -d -p 127.0.0.1:18790:18790 -v mhnos-workspace:/workspace mhnos/runtime

  # Or use docker-compose
  docker-compose up -d

  # Test connection
  curl http://localhost:18790/health


WebSocket Protocol Example

  // Connect to runtime
  const ws = new WebSocket('ws://localhost:18790');

  // Spawn a Node.js process
  ws.send(JSON.stringify({
    type: 'spawn',
    processType: 'node',
    command: 'script.js',
    args: ['--port', '3000']
  }));

  // Receive output
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    // { type: 'stdout', pid: 1000, data: 'Hello' }
  };


---

  # Without OpenClaw (default)
  docker build -t mhnos/runtime .

  # With OpenClaw
  docker build --build-arg INSTALL_OPENCLAW=true -t mhnos/runtime:openclaw .
• Fixed! The issue was that Docker's COPY --from doesn't support shell operators like || true - it fails immediately if the s
  ource doesn't exist.

  The fix moves the OpenClaw installation directly into the runtime stage with a conditional RUN command:

  ARG INSTALL_OPENCLAW=false
  ...
  RUN if [ "$INSTALL_OPENCLAW" = "true" ]; then \
      npm install -g openclaw@latest; \
  fi

  Build without OpenClaw (default):

  docker build -t mhnos/runtime .

  Build with OpenClaw:

  docker build --build-arg INSTALL_OPENCLAW=true -t mhnos/runtime:openclaw .

---
TO TEST
---

1. Verify Runtime is Accessible

  First, check if the runtime is responding:

  # In your host terminal
  curl http://localhost:18790/health

  You should see:

  {"status":"ok","uptime":123,"processes":{"totalSpawned":0,"totalKilled":0,"active":0}}

  2. Connect from MHNOS Web OS

  In the MHNOS shell, connect to the runtime:

  runtime connect ws://localhost:18790

  You should see: [Runtime] Connected to external runtime (green)

  Check status:

  runtime status

  3. Test with a Simple Node.js Script

  Create a test file in OPFS:

  edit /test-hello.js

  Add this content:

  console.log("Hello from external runtime!");
  console.log("Node version:", process.version);
  console.log("Working directory:", process.cwd());
  setTimeout(() => console.log("Done!"), 1000);

Save (Ctrl+S in editor), then sync and run:

  # Sync files to runtime
  fsync push

  # Spawn the process in runtime
  runtime spawn node /workspace/test-hello.js

  You should see: [Runtime Process 1000] Started: /workspace/test-hello.js

  4. Attach Terminal to See Output

  # Get the PID from runtime list
  runtime list

  # Attach terminal
  term --runtime 1000

  Or use:

  runtime attach 1000

  5. Run an Interactive Shell

  # Spawn a bash shell
  rshell

  # Get the PID
  runtime list

  # Attach with terminal
  term --runtime <pid>

  Now you have a full bash shell in the runtime container!

6. Test Workerd (if you have a config)

  Create a simple workerd config:

  edit /hello.capnp

  Content:

  using Workerd = import "/workerd/workerd.capnp";

  const config :Workerd.Config = (
    services = [(name = "main", worker = .worker)],
    sockets = [(name = "http", address = "127.0.0.1:8080", http = (), service = "main")]
  );

  const worker :Workerd.Worker = (
    compatibilityDate = "2025-01-01",
    compatibilityFlags = ["nodejs_compat"],
    modules = [(name = "main", esModule = embed "hello.js")]
  );

  Create the worker:

  edit /hello.js

  export default {
    async fetch(request) {
      return new Response("Hello from Workerd!");
    }
  };

  Sync and run:

  fsync push
  workerd /workspace/hello.capnp

  Troubleshooting

  If connection fails:

  # Check Docker container is running
  docker ps | grep mhnos

  # Check logs
  docker logs mhnos-runtime

  # Test WebSocket with curl
  curl -i -N \
    -H "Connection: Upgrade" \
    -H "Upgrade: websocket" \
    -H "Host: localhost:18790" \
    -H "Origin: http://localhost" \
    http://localhost:18790/


---



  Quick Reference

  Start Runtime:

  cd runtime
  docker-compose up -d

  Connect from MHNOS:

  runtime connect

  Use OpenClaw:

  docker-compose --profile openclaw up -d
  runtime connect ws://localhost:18791
  openclaw start

  File Sharing:

  1. Files go in ~/mhnos-workspace (or your mounted path)
  2. Runtime sees them at /workspace
  3. Both can read/write simultaneously



