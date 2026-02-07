#!/usr/bin/env node
/**
 * MHNOS Workerd Runtime Bridge Server
 * 
 * This server bridges between the MHNOS web OS (browser) and the external
 * workerd/Node.js runtime. It provides:
 * - WebSocket communication with the browser
 * - Process spawning and management (workerd, node, openclaw, shell)
 * - TTY/stdio forwarding
 * - File synchronization between OPFS and runtime workspace
 */

import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { spawn, execFile } from 'child_process';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  port: parseInt(process.env.MHNOS_RUNTIME_PORT, 10) || 18790,
  workspace: process.env.MHNOS_WORKSPACE || '/workspace',
  allowOpenClaw: process.env.MHNOS_ALLOW_OPENCLAW === 'true',
  sandboxMode: process.env.MHNOS_SANDBOX || 'strict', // strict, relaxed, none
  logLevel: process.env.MHNOS_LOG_LEVEL || 'info',
  maxProcesses: parseInt(process.env.MHNOS_MAX_PROCESSES, 10) || 50,
  maxProcessMemory: process.env.MHNOS_MAX_MEMORY || '1g',
  heartbeatInterval: 30000, // 30 seconds
};

// =============================================================================
// Logging
// =============================================================================

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const CURRENT_LOG_LEVEL = LOG_LEVELS[CONFIG.logLevel] ?? 1;

function log(level, message, meta = {}) {
  const levelNum = LOG_LEVELS[level] ?? 1;
  if (levelNum < CURRENT_LOG_LEVEL) return;
  
  const timestamp = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message} ${metaStr}`);
}

// =============================================================================
// Process Registry
// =============================================================================

class ProcessRegistry {
  constructor() {
    this.processes = new Map();
    this.pidCounter = 1000;
    this.stats = {
      totalSpawned: 0,
      totalKilled: 0,
      active: 0,
    };
  }

  generatePid() {
    return this.pidCounter++;
  }

  register(process) {
    this.processes.set(process.pid, process);
    this.stats.totalSpawned++;
    this.stats.active++;
    log('info', `Process registered`, { pid: process.pid, type: process.type });
  }

  unregister(pid) {
    const proc = this.processes.get(pid);
    if (proc) {
      this.processes.delete(pid);
      this.stats.totalKilled++;
      this.stats.active--;
      log('info', `Process unregistered`, { pid });
      return proc;
    }
    return null;
  }

  get(pid) {
    return this.processes.get(pid);
  }

  list() {
    return Array.from(this.processes.values()).map(p => ({
      pid: p.pid,
      type: p.type,
      command: p.command,
      args: p.args,
      startTime: p.startTime,
      status: p.status,
    }));
  }

  getStats() {
    return { ...this.stats };
  }

  async killAll(signal = 'SIGTERM') {
    log('warn', `Killing all ${this.processes.size} processes with ${signal}`);
    const promises = [];
    for (const proc of this.processes.values()) {
      promises.push(proc.kill(signal));
    }
    await Promise.all(promises);
  }
}

const registry = new ProcessRegistry();

// =============================================================================
// Managed Process Class
// =============================================================================

class ManagedProcess {
  constructor(type, command, args = [], options = {}) {
    this.pid = registry.generatePid();
    this.type = type;
    this.command = command;
    this.args = args;
    this.options = {
      cwd: options.cwd || CONFIG.workspace,
      env: options.env || {},
      timeout: options.timeout || 0,
      ...options,
    };
    
    this.child = null;
    this.pty = null;
    this.startTime = Date.now();
    this.status = 'starting';
    this.exitCode = null;
    this.wsClients = new Set();
    this.outputBuffer = [];
    this.maxBufferSize = 1000;
    this.timer = null;
  }

  async spawn() {
    if (registry.processes.size >= CONFIG.maxProcesses) {
      throw new Error(`Maximum process limit reached (${CONFIG.maxProcesses})`);
    }

    try {
      switch (this.type) {
        case 'workerd':
          await this.spawnWorkerd();
          break;
        case 'node':
          await this.spawnNode();
          break;
        case 'shell':
          await this.spawnShell();
          break;
        case 'openclaw':
          await this.spawnOpenClaw();
          break;
        case 'python':
          await this.spawnPython();
          break;
        default:
          throw new Error(`Unknown process type: ${this.type}`);
      }

      this.status = 'running';
      registry.register(this);
      this.setupTimeout();
      
      return this.pid;
    } catch (error) {
      this.status = 'error';
      log('error', `Failed to spawn process`, { pid: this.pid, error: error.message });
      throw error;
    }
  }

  spawnWorkerd() {
    return new Promise((resolve, reject) => {
      const configPath = this.createWorkerdConfig();
      const env = this.getSandboxedEnv();
      
      this.child = spawn('workerd', ['serve', configPath, '--verbose'], {
        cwd: this.options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.setupStdio();
      this.setupExitHandler();
      
      // Give workerd a moment to start
      setTimeout(() => resolve(), 500);
    });
  }

  spawnNode() {
    return new Promise((resolve, reject) => {
      const env = this.getSandboxedEnv();
      
      // Add memory limit if specified
      const execArgs = [];
      if (CONFIG.maxProcessMemory) {
        execArgs.push(`--max-old-space-size=${parseMemoryLimit(CONFIG.maxProcessMemory)}`);
      }
      
      this.child = spawn('node', [...execArgs, this.command, ...this.args], {
        cwd: this.options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.setupStdio();
      this.setupExitHandler();
      
      resolve();
    });
  }

  async spawnShell() {
    // Use node-pty for proper TTY support
    const { default: pty } = await import('@lydell/node-pty');
    
    const shell = process.env.SHELL || '/bin/bash';
    const env = this.getSandboxedEnv();
    
    this.pty = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: this.options.cwd,
      env,
    });

    this.pty.onData((data) => {
      this.broadcast({ type: 'stdout', data });
      this.bufferOutput({ type: 'stdout', data });
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this.handleExit(exitCode, signal);
    });
  }

  spawnOpenClaw() {
    return new Promise((resolve, reject) => {
      if (!CONFIG.allowOpenClaw) {
        reject(new Error('OpenClaw is not enabled in this runtime'));
        return;
      }

      const env = {
        ...this.getSandboxedEnv(),
        OPENCLAW_WORKSPACE: CONFIG.workspace,
        OPENCLAW_SANDBOX: CONFIG.sandboxMode,
        OPENCLAW_GATEWAY_PORT: '0', // Random available port
      };

      this.child = spawn('openclaw', [this.command || 'gateway', ...this.args], {
        cwd: this.options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.setupStdio();
      this.setupExitHandler();
      
      resolve();
    });
  }

  spawnPython() {
    return new Promise((resolve, reject) => {
      const env = this.getSandboxedEnv();
      
      this.child = spawn('python3', [this.command, ...this.args], {
        cwd: this.options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.setupStdio();
      this.setupExitHandler();
      
      resolve();
    });
  }

  createWorkerdConfig() {
    // TODO: Generate capnp config file
    // For now, return a placeholder
    return join(__dirname, 'templates', 'default.capnp');
  }

  getSandboxedEnv() {
    // Start with minimal environment
    const env = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: CONFIG.workspace,
      USER: 'mhnos',
      NODE_ENV: 'production',
      TERM: 'xterm-256color',
    };

    // Add allowed environment variables from parent
    const allowedVars = ['LANG', 'LC_ALL', 'TZ', 'DEBUG'];
    for (const key of allowedVars) {
      if (process.env[key]) env[key] = process.env[key];
    }

    // Merge with user-provided env (which takes precedence)
    return { ...env, ...this.options.env };
  }

  setupStdio() {
    if (!this.child) return;

    this.child.stdout.on('data', (data) => {
      const str = data.toString('utf8');
      this.broadcast({ type: 'stdout', data: str });
      this.bufferOutput({ type: 'stdout', data: str });
    });

    this.child.stderr.on('data', (data) => {
      const str = data.toString('utf8');
      this.broadcast({ type: 'stderr', data: str });
      this.bufferOutput({ type: 'stderr', data: str });
    });
  }

  setupExitHandler() {
    if (!this.child) return;

    this.child.on('exit', (code, signal) => {
      this.handleExit(code, signal);
    });

    this.child.on('error', (error) => {
      log('error', `Process error`, { pid: this.pid, error: error.message });
      this.broadcast({ type: 'error', error: error.message });
    });
  }

  handleExit(code, signal) {
    this.status = 'exited';
    this.exitCode = code;
    
    log('info', `Process exited`, { pid: this.pid, code, signal });
    
    this.broadcast({
      type: 'exit',
      code,
      signal,
      runtime: Date.now() - this.startTime,
    });

    this.clearTimeout();
    registry.unregister(this.pid);
  }

  setupTimeout() {
    if (this.options.timeout > 0) {
      this.timer = setTimeout(() => {
        log('warn', `Process timeout reached, killing`, { pid: this.pid });
        this.kill('SIGTERM');
      }, this.options.timeout);
    }
  }

  clearTimeout() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  bufferOutput(message) {
    this.outputBuffer.push({
      ...message,
      timestamp: Date.now(),
    });
    
    // Trim buffer if too large
    if (this.outputBuffer.length > this.maxBufferSize) {
      this.outputBuffer = this.outputBuffer.slice(-this.maxBufferSize);
    }
  }

  broadcast(message) {
    const payload = JSON.stringify({ ...message, pid: this.pid });
    for (const ws of this.wsClients) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(payload);
      }
    }
  }

  attach(ws) {
    this.wsClients.add(ws);
    
    // Send recent output buffer to catch up
    for (const msg of this.outputBuffer) {
      ws.send(JSON.stringify({ ...msg, pid: this.pid }));
    }
  }

  detach(ws) {
    this.wsClients.delete(ws);
  }

  write(data) {
    if (this.pty) {
      this.pty.write(data);
    } else if (this.child?.stdin) {
      this.child.stdin.write(data);
    }
  }

  resize(cols, rows) {
    if (this.pty) {
      this.pty.resize(cols, rows);
    }
  }

  async kill(signal = 'SIGTERM') {
    log('info', `Killing process`, { pid: this.pid, signal });
    
    this.clearTimeout();
    
    if (this.pty) {
      this.pty.kill(signal);
    } else if (this.child) {
      this.child.kill(signal);
      
      // Force kill after timeout
      setTimeout(() => {
        if (this.child && !this.child.killed) {
          log('warn', `Force killing process`, { pid: this.pid });
          this.child.kill('SIGKILL');
        }
      }, 5000);
    }
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

function parseMemoryLimit(limit) {
  const match = limit.match(/^(\d+)([mg]?)$/i);
  if (!match) return 1024; // Default 1GB
  const [, num, unit] = match;
  const multiplier = unit === 'g' ? 1024 : 1;
  return parseInt(num, 10) * multiplier;
}

async function validatePath(filepath) {
  const resolved = path.isAbsolute(filepath) 
    ? filepath 
    : path.resolve(CONFIG.workspace, filepath);
  
  // Ensure path is within workspace
  const relative = resolved.replace(CONFIG.workspace, '');
  if (relative.includes('..')) {
    throw new Error('Path traversal detected');
  }
  
  return resolved;
}

// =============================================================================
// Message Handlers
// =============================================================================

const handlers = {
  async spawn(ws, msg) {
    const proc = new ManagedProcess(
      msg.processType,
      msg.command,
      msg.args,
      msg.options
    );
    
    const pid = await proc.spawn();
    proc.attach(ws);
    
    ws.send(JSON.stringify({
      type: 'spawned',
      id: msg.id,
      pid,
      status: 'success',
    }));
  },

  attach(ws, msg) {
    const proc = registry.get(msg.pid);
    if (!proc) {
      ws.send(JSON.stringify({
        type: 'error',
        id: msg.id,
        error: `Process ${msg.pid} not found`,
      }));
      return;
    }
    
    proc.attach(ws);
    ws.send(JSON.stringify({
      type: 'attached',
      id: msg.id,
      pid: msg.pid,
      status: proc.status,
    }));
  },

  detach(ws, msg) {
    const proc = registry.get(msg.pid);
    if (proc) {
      proc.detach(ws);
    }
    
    ws.send(JSON.stringify({
      type: 'detached',
      id: msg.id,
      pid: msg.pid,
    }));
  },

  write(ws, msg) {
    const proc = registry.get(msg.pid);
    if (proc) {
      proc.write(msg.data);
    }
  },

  resize(ws, msg) {
    const proc = registry.get(msg.pid);
    if (proc) {
      proc.resize(msg.cols, msg.rows);
    }
  },

  async kill(ws, msg) {
    const proc = registry.get(msg.pid);
    if (proc) {
      await proc.kill(msg.signal || 'SIGTERM');
    }
    
    ws.send(JSON.stringify({
      type: 'killed',
      id: msg.id,
      pid: msg.pid,
    }));
  },

  list(ws, msg) {
    const processes = registry.list();
    const stats = registry.getStats();
    
    ws.send(JSON.stringify({
      type: 'processList',
      id: msg.id,
      processes,
      stats,
    }));
  },

  status(ws, msg) {
    ws.send(JSON.stringify({
      type: 'status',
      id: msg.id,
      config: {
        workspace: CONFIG.workspace,
        sandboxMode: CONFIG.sandboxMode,
        allowOpenClaw: CONFIG.allowOpenClaw,
        maxProcesses: CONFIG.maxProcesses,
      },
      stats: registry.getStats(),
    }));
  },

  ping(ws, msg) {
    ws.send(JSON.stringify({
      type: 'pong',
      id: msg.id,
      time: Date.now(),
    }));
  },

  async fsync(ws, msg) {
    const { operation, files } = msg;
    
    log('info', `Fsync request`, { operation, fileCount: files?.length || 0, id: msg.id });
    
    try {
      if (operation === 'push') {
        // Receive files from client and write to workspace
        const results = { synced: 0, failed: 0, errors: [] };
        const startTime = Date.now();
        
        for (const file of (files || [])) {
          try {
            log('debug', `Processing file`, { path: file.path, kind: file.kind });
            
            // Validate path is within workspace
            const cleanPath = file.path.replace(/^\//, '');
            const fullPath = path.resolve(CONFIG.workspace, cleanPath);
            
            if (!fullPath.startsWith(CONFIG.workspace)) {
              throw new Error('Path traversal detected');
            }
            
            if (file.kind === 'directory') {
              // Create directory
              await fs.mkdir(fullPath, { recursive: true });
              log('debug', `Created directory`, { path: fullPath });
            } else if (file.kind === 'file') {
              // Ensure parent directory exists
              const dir = path.dirname(fullPath);
              await fs.mkdir(dir, { recursive: true });
              
              // Write file content
              if (file.content && file.content.length > 0) {
                const buffer = Buffer.from(file.content);
                await fs.writeFile(fullPath, buffer);
                log('debug', `Wrote file`, { path: fullPath, size: buffer.length });
              } else {
                // Create empty file
                await fs.writeFile(fullPath, '');
                log('debug', `Created empty file`, { path: fullPath });
              }
            }
            results.synced++;
          } catch (err) {
            results.failed++;
            results.errors.push({ path: file.path, error: err.message });
            log('warn', `File sync failed`, { path: file.path, error: err.message });
          }
        }
        
        const duration = Date.now() - startTime;
        log('info', `Fsync push complete`, { duration, synced: results.synced, failed: results.failed });
        
        ws.send(JSON.stringify({
          type: 'fsyncResult',
          id: msg.id,
          operation: 'push',
          status: 'success',
          results,
        }));
        
      } else if (operation === 'pull') {
        // Read files from workspace and send to client
        // For now, just acknowledge - full implementation would scan directory
        ws.send(JSON.stringify({
          type: 'fsyncResult',
          id: msg.id,
          operation: 'pull',
          status: 'success',
          files: [], // TODO: Implement directory scanning
        }));
        
      } else {
        ws.send(JSON.stringify({
          type: 'fsyncResult',
          id: msg.id,
          status: 'error',
          error: `Unknown operation: ${operation}`,
        }));
      }
    } catch (err) {
      log('error', `Fsync error`, { error: err.message, id: msg.id });
      ws.send(JSON.stringify({
        type: 'fsyncResult',
        id: msg.id,
        status: 'error',
        error: err.message,
      }));
    }
  },
};

// =============================================================================
// WebSocket Server
// =============================================================================

const httpServer = createServer((req, res) => {
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      processes: registry.getStats(),
    }));
    return;
  }
  
  res.writeHead(404);
  res.end('Not Found');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  log('info', `Client connected`, { ip: clientIp });
  
  // Send welcome message with protocol version
  ws.send(JSON.stringify({
    type: 'connected',
    protocolVersion: '1.0.0',
    config: {
      workspace: CONFIG.workspace,
      sandboxMode: CONFIG.sandboxMode,
      allowOpenClaw: CONFIG.allowOpenClaw,
    },
  }));

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      
      // Log all messages at info level for debugging
      log('info', `Received message`, { type: msg.type, id: msg.id, payloadSize: raw.length });
      
      const handler = handlers[msg.type];
      if (handler) {
        try {
          await handler(ws, msg);
        } catch (error) {
          log('error', `Handler error`, { type: msg.type, error: error.message });
          ws.send(JSON.stringify({
            type: 'error',
            id: msg.id,
            error: error.message,
          }));
        }
      } else {
        log('warn', `Unknown message type`, { type: msg.type });
        ws.send(JSON.stringify({
          type: 'error',
          id: msg.id,
          error: `Unknown message type: ${msg.type}`,
        }));
      }
    } catch (error) {
      log('error', `Message parsing error`, { error: error.message });
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Invalid message format',
      }));
    }
  });

  ws.on('close', () => {
    log('info', `Client disconnected`, { ip: clientIp });
    
    // Detach from all processes
    for (const proc of registry.processes.values()) {
      proc.detach(ws);
    }
  });

  ws.on('error', (error) => {
    log('error', `WebSocket error`, { error: error.message });
  });
});

// =============================================================================
// Startup
// =============================================================================

async function startup() {
  // Ensure workspace directory exists
  try {
    await fs.mkdir(CONFIG.workspace, { recursive: true });
    log('info', `Workspace ready`, { path: CONFIG.workspace });
  } catch (error) {
    log('error', `Failed to create workspace`, { error: error.message });
    process.exit(1);
  }

  // Check workerd binary
  execFile('workerd', ['--version'], (error, stdout) => {
    if (error) {
      log('warn', `Workerd not found, workerd processes will fail`);
    } else {
      log('info', `Workerd available`, { version: stdout.trim() });
    }
  });

  // Check OpenClaw if enabled
  if (CONFIG.allowOpenClaw) {
    execFile('openclaw', ['--version'], (error, stdout) => {
      if (error) {
        log('warn', `OpenClaw not found but is enabled`);
      } else {
        log('info', `OpenClaw available`, { version: stdout.trim() });
      }
    });
  }

  // Start server
  httpServer.listen(CONFIG.port, () => {
    log('info', `MHNOS Runtime Bridge started`, {
      port: CONFIG.port,
      workspace: CONFIG.workspace,
      sandboxMode: CONFIG.sandboxMode,
      allowOpenClaw: CONFIG.allowOpenClaw,
    });
  });
}

// =============================================================================
// Shutdown Handling
// =============================================================================

async function shutdown(signal) {
  log('warn', `Shutting down (${signal})...`);
  
  // Stop accepting new connections
  wss.close();
  httpServer.close();
  
  // Kill all running processes
  await registry.killAll('SIGTERM');
  
  // Give processes time to clean up
  setTimeout(() => {
    log('info', `Shutdown complete`);
    process.exit(0);
  }, 2000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  log('error', `Uncaught exception`, { error: error.message, stack: error.stack });
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  log('error', `Unhandled rejection`, { reason });
});

// =============================================================================
// Run
// =============================================================================

startup();
