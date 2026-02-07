#!/usr/bin/env node
/**
 * MHNOS Workerd Runtime Bridge Server - Remote VPS Edition with S3
 * 
 * This server bridges between the MHNOS web OS (browser) and the external
 * workerd/Node.js runtime, with MinIO S3 integration for file storage.
 * 
 * Features:
 * - WebSocket communication with the browser
 * - Process spawning and management (workerd, node, openclaw, shell)
 * - TTY/stdio forwarding
 * - S3-compatible object storage via MinIO (presigned URLs, sync)
 */

import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { spawn, execFile } from 'child_process';
import { promises as fs, createReadStream, createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { pipeline } from 'stream/promises';

// S3 SDK imports
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
  sandboxMode: process.env.MHNOS_SANDBOX || 'relaxed',
  logLevel: process.env.MHNOS_LOG_LEVEL || 'info',
  maxProcesses: parseInt(process.env.MHNOS_MAX_PROCESSES, 10) || 50,
  maxProcessMemory: process.env.MHNOS_MAX_MEMORY || '2g',
  heartbeatInterval: 30000,
  
  // S3 Configuration
  s3: {
    endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || 'http://minio:9000',
    bucket: process.env.S3_BUCKET || 'workspace',
    accessKey: process.env.S3_ACCESS_KEY || '',
    secretKey: process.env.S3_SECRET_KEY || '',
    region: process.env.S3_REGION || 'us-east-1',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    presignExpiry: parseInt(process.env.S3_PRESIGN_EXPIRY, 10) || 3600,
  },
  
  // Sync configuration
  sync: {
    onConnect: process.env.SYNC_ON_CONNECT === 'true',
    excludePatterns: (process.env.SYNC_EXCLUDE_PATTERNS || 'node_modules,.git,dist,.cache,*.tmp').split(','),
    maxFileSize: 5 * 1024 * 1024 * 1024, // 5GB (S3 limit for single PUT)
    multipartThreshold: 100 * 1024 * 1024, // 100MB
  }
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
// S3 Client
// =============================================================================

let s3Client = null;

function initS3Client() {
  if (!CONFIG.s3.accessKey || !CONFIG.s3.secretKey) {
    log('warn', 'S3 credentials not configured, S3 features disabled');
    return null;
  }
  
  try {
    // Use internal endpoint for the client (server-side operations)
    s3Client = new S3Client({
      endpoint: CONFIG.s3.endpoint,
      region: CONFIG.s3.region,
      credentials: {
        accessKeyId: CONFIG.s3.accessKey,
        secretAccessKey: CONFIG.s3.secretKey,
      },
      forcePathStyle: true,
    });
    
    log('info', 'S3 client initialized', { 
      endpoint: CONFIG.s3.endpoint, 
      bucket: CONFIG.s3.bucket 
    });
    
    return s3Client;
  } catch (error) {
    log('error', 'Failed to initialize S3 client', { error: error.message });
    return null;
  }
}

// Get public-facing endpoint (for presigned URLs)
function getPublicEndpoint() {
  return CONFIG.s3.publicEndpoint || CONFIG.s3.endpoint;
}

// =============================================================================
// S3 Operations
// =============================================================================

// Create a temporary S3 client for presigned URL generation with public endpoint
function createPublicS3Client() {
  const publicEndpoint = getPublicEndpoint();
  if (!publicEndpoint) return null;
  
  return new S3Client({
    endpoint: publicEndpoint,
    region: CONFIG.s3.region,
    credentials: {
      accessKeyId: CONFIG.s3.accessKey,
      secretAccessKey: CONFIG.s3.secretKey,
    },
    forcePathStyle: true,
  });
}

async function generatePresignedUpload(key, contentType = 'application/octet-stream', expiry = CONFIG.s3.presignExpiry) {
  if (!s3Client) throw new Error('S3 not configured');
  
  const command = new PutObjectCommand({
    Bucket: CONFIG.s3.bucket,
    Key: key,
    ContentType: contentType,
  });
  
  // Use public endpoint client for presigned URLs so browsers can access them
  const publicClient = createPublicS3Client();
  const client = publicClient || s3Client;
  
  const url = await getSignedUrl(client, command, { expiresIn: expiry });
  
  log('debug', 'Generated presigned upload URL', { key, url: url.substring(0, 100) + '...' });
  
  return url;
}

async function generatePresignedDownload(key, expiry = CONFIG.s3.presignExpiry) {
  if (!s3Client) throw new Error('S3 not configured');
  
  const command = new GetObjectCommand({
    Bucket: CONFIG.s3.bucket,
    Key: key,
  });
  
  // Use public endpoint client for presigned URLs so browsers can access them
  const publicClient = createPublicS3Client();
  const client = publicClient || s3Client;
  
  const url = await getSignedUrl(client, command, { expiresIn: expiry });
  return url;
}

async function listS3Objects(prefix = '', maxKeys = 1000) {
  if (!s3Client) throw new Error('S3 not configured');
  
  const objects = [];
  let continuationToken = null;
  
  do {
    const command = new ListObjectsV2Command({
      Bucket: CONFIG.s3.bucket,
      Prefix: prefix,
      MaxKeys: maxKeys,
      ContinuationToken: continuationToken,
    });
    
    const response = await s3Client.send(command);
    
    for (const obj of response.Contents || []) {
      objects.push({
        key: obj.Key,
        size: obj.Size,
        lastModified: obj.LastModified.toISOString(),
        etag: obj.ETag,
      });
    }
    
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  
  return objects;
}

async function deleteS3Object(key) {
  if (!s3Client) throw new Error('S3 not configured');
  
  const command = new DeleteObjectCommand({
    Bucket: CONFIG.s3.bucket,
    Key: key,
  });
  
  await s3Client.send(command);
  return { deleted: true, key };
}

async function getS3ObjectMetadata(key) {
  if (!s3Client) throw new Error('S3 not configured');
  
  try {
    const command = new HeadObjectCommand({
      Bucket: CONFIG.s3.bucket,
      Key: key,
    });
    
    const response = await s3Client.send(command);
    return {
      exists: true,
      key,
      size: response.ContentLength,
      lastModified: response.LastModified?.toISOString() || new Date().toISOString(),
      contentType: response.ContentType,
      etag: response.ETag,
    };
  } catch (error) {
    if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
      return { exists: false, key };
    }
    throw error;
  }
}

// =============================================================================
// Process Registry (same as original)
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
// Managed Process Class (same as original)
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
      
      setTimeout(() => resolve(), 500);
    });
  }

  spawnNode() {
    return new Promise((resolve, reject) => {
      const env = this.getSandboxedEnv();
      
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
        OPENCLAW_GATEWAY_PORT: '0',
        // Pass S3 config to OpenClaw
        S3_ENDPOINT: CONFIG.s3.endpoint,
        S3_BUCKET: CONFIG.s3.bucket,
        S3_ACCESS_KEY: CONFIG.s3.accessKey,
        S3_SECRET_KEY: CONFIG.s3.secretKey,
        S3_REGION: CONFIG.s3.region,
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
    return path.join(__dirname, 'templates', 'default.capnp');
  }

  getSandboxedEnv() {
    const env = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: CONFIG.workspace,
      USER: 'mhnos',
      NODE_ENV: 'production',
      TERM: 'xterm-256color',
      // Include S3 config
      S3_ENDPOINT: CONFIG.s3.endpoint,
      S3_BUCKET: CONFIG.s3.bucket,
      S3_ACCESS_KEY: CONFIG.s3.accessKey,
      S3_SECRET_KEY: CONFIG.s3.secretKey,
      S3_REGION: CONFIG.s3.region,
    };

    const allowedVars = ['LANG', 'LC_ALL', 'TZ', 'DEBUG'];
    for (const key of allowedVars) {
      if (process.env[key]) env[key] = process.env[key];
    }

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
    
    if (this.outputBuffer.length > this.maxBufferSize) {
      this.outputBuffer = this.outputBuffer.slice(-this.maxBufferSize);
    }
  }

  broadcast(message) {
    const payload = JSON.stringify({ ...message, pid: this.pid });
    for (const ws of this.wsClients) {
      if (ws.readyState === 1) {
        ws.send(payload);
      }
    }
  }

  attach(ws) {
    this.wsClients.add(ws);
    
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
  if (!match) return 1024;
  const [, num, unit] = match;
  const multiplier = unit === 'g' ? 1024 : 1;
  return parseInt(num, 10) * multiplier;
}

async function validatePath(filepath) {
  const resolved = path.isAbsolute(filepath) 
    ? filepath 
    : path.resolve(CONFIG.workspace, filepath);
  
  const relative = resolved.replace(CONFIG.workspace, '');
  if (relative.includes('..')) {
    throw new Error('Path traversal detected');
  }
  
  return resolved;
}

// =============================================================================
// Enhanced Message Handlers with S3 Support
// =============================================================================

const handlers = {
  // Original handlers
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
        s3Enabled: !!s3Client,
        s3Bucket: CONFIG.s3.bucket,
        s3Endpoint: getPublicEndpoint(),
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

  // Legacy fsync handler (for small files)
  async fsync(ws, msg) {
    const { operation, files } = msg;
    
    log('info', `Fsync request`, { operation, fileCount: files?.length || 0, id: msg.id });
    
    try {
      if (operation === 'push') {
        const results = { synced: 0, failed: 0, errors: [] };
        
        for (const file of (files || [])) {
          try {
            const cleanPath = file.path.replace(/^\//, '');
            const fullPath = path.resolve(CONFIG.workspace, cleanPath);
            
            if (!fullPath.startsWith(CONFIG.workspace)) {
              throw new Error('Path traversal detected');
            }
            
            if (file.kind === 'directory') {
              await fs.mkdir(fullPath, { recursive: true });
            } else if (file.kind === 'file') {
              const dir = path.dirname(fullPath);
              await fs.mkdir(dir, { recursive: true });
              
              if (file.content && file.content.length > 0) {
                const buffer = Buffer.from(file.content);
                await fs.writeFile(fullPath, buffer);
              } else {
                await fs.writeFile(fullPath, '');
              }
            }
            results.synced++;
          } catch (err) {
            results.failed++;
            results.errors.push({ path: file.path, error: err.message });
          }
        }
        
        ws.send(JSON.stringify({
          type: 'fsyncResult',
          id: msg.id,
          operation: 'push',
          status: 'success',
          results,
        }));
        
      } else if (operation === 'pull') {
        ws.send(JSON.stringify({
          type: 'fsyncResult',
          id: msg.id,
          operation: 'pull',
          status: 'success',
          files: [],
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
      ws.send(JSON.stringify({
        type: 'fsyncResult',
        id: msg.id,
        status: 'error',
        error: err.message,
      }));
    }
  },

  // ==========================================================================
  // S3 Handlers
  // ==========================================================================
  
  async s3Status(ws, msg) {
    try {
      let bucketAccessible = false;
      
      if (s3Client) {
        try {
          // Try to list objects to check if bucket is accessible
          const command = new ListObjectsV2Command({
            Bucket: CONFIG.s3.bucket,
            MaxKeys: 1,
          });
          await s3Client.send(command);
          bucketAccessible = true;
        } catch (e) {
          bucketAccessible = false;
        }
      }
      
      ws.send(JSON.stringify({
        type: 's3Status',
        id: msg.id,
        status: 'success',
        enabled: !!s3Client,
        config: {
          bucket: CONFIG.s3.bucket,
          endpoint: getPublicEndpoint(),
          region: CONFIG.s3.region,
        },
        bucketAccessible,
      }));
    } catch (error) {
      ws.send(JSON.stringify({
        type: 's3Status',
        id: msg.id,
        status: 'error',
        error: error.message,
      }));
    }
  },

  async s3GetUploadUrl(ws, msg) {
    try {
      if (!s3Client) throw new Error('S3 not configured');
      
      const { key, contentType, expiry } = msg;
      const url = await generatePresignedUpload(key, contentType, expiry);
      
      ws.send(JSON.stringify({
        type: 's3UploadUrl',
        id: msg.id,
        status: 'success',
        url,
        key,
        expiresIn: expiry || CONFIG.s3.presignExpiry,
      }));
    } catch (error) {
      ws.send(JSON.stringify({
        type: 's3UploadUrl',
        id: msg.id,
        status: 'error',
        error: error.message,
      }));
    }
  },

  async s3GetDownloadUrl(ws, msg) {
    try {
      if (!s3Client) throw new Error('S3 not configured');
      
      const { key, expiry } = msg;
      const url = await generatePresignedDownload(key, expiry);
      
      ws.send(JSON.stringify({
        type: 's3DownloadUrl',
        id: msg.id,
        status: 'success',
        url,
        key,
        expiresIn: expiry || CONFIG.s3.presignExpiry,
      }));
    } catch (error) {
      ws.send(JSON.stringify({
        type: 's3DownloadUrl',
        id: msg.id,
        status: 'error',
        error: error.message,
      }));
    }
  },

  async s3List(ws, msg) {
    try {
      if (!s3Client) throw new Error('S3 not configured');
      
      const { prefix, maxKeys } = msg;
      const objects = await listS3Objects(prefix, maxKeys);
      
      ws.send(JSON.stringify({
        type: 's3List',
        id: msg.id,
        status: 'success',
        objects,
        count: objects.length,
      }));
    } catch (error) {
      ws.send(JSON.stringify({
        type: 's3List',
        id: msg.id,
        status: 'error',
        error: error.message,
      }));
    }
  },

  async s3Delete(ws, msg) {
    try {
      if (!s3Client) throw new Error('S3 not configured');
      
      const { key } = msg;
      const result = await deleteS3Object(key);
      
      ws.send(JSON.stringify({
        type: 's3Delete',
        id: msg.id,
        status: 'success',
        result,
      }));
    } catch (error) {
      ws.send(JSON.stringify({
        type: 's3Delete',
        id: msg.id,
        status: 'error',
        error: error.message,
      }));
    }
  },

  async s3GetMetadata(ws, msg) {
    try {
      if (!s3Client) throw new Error('S3 not configured');
      
      const { key } = msg;
      const metadata = await getS3ObjectMetadata(key);
      
      ws.send(JSON.stringify({
        type: 's3Metadata',
        id: msg.id,
        status: 'success',
        metadata,
      }));
    } catch (error) {
      ws.send(JSON.stringify({
        type: 's3Metadata',
        id: msg.id,
        status: 'error',
        error: error.message,
      }));
    }
  },

  // Batch upload handler - returns multiple presigned URLs
  async s3GetBatchUploadUrls(ws, msg) {
    try {
      if (!s3Client) throw new Error('S3 not configured');
      
      const { files } = msg; // Array of {key, contentType}
      const urls = [];
      
      for (const file of files) {
        const url = await generatePresignedUpload(
          file.key, 
          file.contentType, 
          file.expiry
        );
        urls.push({
          key: file.key,
          url,
          contentType: file.contentType,
        });
      }
      
      ws.send(JSON.stringify({
        type: 's3BatchUploadUrls',
        id: msg.id,
        status: 'success',
        urls,
      }));
    } catch (error) {
      ws.send(JSON.stringify({
        type: 's3BatchUploadUrls',
        id: msg.id,
        status: 'error',
        error: error.message,
      }));
    }
  },

  // Batch download handler
  async s3GetBatchDownloadUrls(ws, msg) {
    try {
      if (!s3Client) throw new Error('S3 not configured');
      
      const { keys } = msg; // Array of keys
      const urls = [];
      
      for (const key of keys) {
        const url = await generatePresignedDownload(key);
        urls.push({ key, url });
      }
      
      ws.send(JSON.stringify({
        type: 's3BatchDownloadUrls',
        id: msg.id,
        status: 'success',
        urls,
      }));
    } catch (error) {
      ws.send(JSON.stringify({
        type: 's3BatchDownloadUrls',
        id: msg.id,
        status: 'error',
        error: error.message,
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
      s3: {
        enabled: !!s3Client,
        bucket: CONFIG.s3.bucket,
      },
    }));
    return;
  }
  
  // S3 config endpoint (public info only)
  if (req.url === '/s3-config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      enabled: !!s3Client,
      bucket: CONFIG.s3.bucket,
      endpoint: getPublicEndpoint(),
      region: CONFIG.s3.region,
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
  
  ws.send(JSON.stringify({
    type: 'connected',
    protocolVersion: '1.1.0',
    config: {
      workspace: CONFIG.workspace,
      sandboxMode: CONFIG.sandboxMode,
      allowOpenClaw: CONFIG.allowOpenClaw,
      s3: {
        enabled: !!s3Client,
        bucket: CONFIG.s3.bucket,
        endpoint: getPublicEndpoint(),
      },
    },
  }));

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      
      log('info', `Received message`, { type: msg.type, id: msg.id });
      
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
  // Initialize S3 client
  initS3Client();
  
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
    log('info', `MHNOS Runtime Bridge (Remote Edition) started`, {
      port: CONFIG.port,
      workspace: CONFIG.workspace,
      sandboxMode: CONFIG.sandboxMode,
      allowOpenClaw: CONFIG.allowOpenClaw,
      s3Enabled: !!s3Client,
      s3Bucket: CONFIG.s3.bucket,
    });
  });
}

// =============================================================================
// Shutdown Handling
// =============================================================================

async function shutdown(signal) {
  log('warn', `Shutting down (${signal})...`);
  
  wss.close();
  httpServer.close();
  
  await registry.killAll('SIGTERM');
  
  setTimeout(() => {
    log('info', `Shutdown complete`);
    process.exit(0);
  }, 2000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

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
