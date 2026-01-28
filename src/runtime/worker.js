// src/runtime/worker.js
import http from './poly/http.js';
import { fs as memfs } from 'https://esm.sh/memfs@4.6.0';
import { Buffer } from 'https://esm.sh/buffer@6.0.3';

// Load Standard Libs from ESM.sh to provide to CJS requires
import EventEmitter from 'https://esm.sh/events';
import * as util from 'https://esm.sh/util';
import * as url from 'https://esm.sh/url';
import * as querystring from 'https://esm.sh/querystring';
import * as stream from 'https://esm.sh/stream';
import * as path from 'https://esm.sh/path';

self.Buffer = Buffer; 

// --- GLOBAL STUBS FOR EXPRESS ---
self.global = self;
class TtyStream extends EventEmitter {
    constructor(stream) {
        super();
        this.isTTY = true;
        this.columns = 100;
        this.rows = 30;
        this._encoding = 'utf8';
        this._stream = stream;
    }
    setEncoding(enc) { this._encoding = enc; return this; }
    write(chunk, enc, cb) {
        if (typeof enc === 'function') {
            cb = enc;
            enc = undefined;
        }
        let text = '';
        const encoding = enc || this._encoding;
        if (typeof chunk === 'string') text = chunk;
        else if (Buffer.isBuffer(chunk)) text = chunk.toString(encoding);
        else if (ArrayBuffer.isView(chunk)) text = Buffer.from(chunk.buffer).toString(encoding);
        else if (chunk instanceof ArrayBuffer) text = Buffer.from(chunk).toString(encoding);
        else text = String(chunk);
        postMessage({ type: 'SYSCALL_TTY_WRITE', payload: { data: text, stream: this._stream } });
        if (cb) cb();
        return true;
    }
    getColorDepth() { return 8; }
    hasColors() { return true; }
    getWindowSize() { return [this.columns, this.rows]; }
    cursorTo(x, y) {
        if (typeof y === 'number') {
            this.write(`\x1b[${y + 1};${x + 1}H`);
        } else {
            this.write(`\x1b[${x + 1}G`);
        }
    }
    clearLine(dir = 0) {
        this.write(`\x1b[${dir}K`);
    }
    clearScreenDown() {
        this.write('\x1b[J');
    }
}

self.process = {
    env: { NODE_ENV: 'development', TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    nextTick: (fn) => setTimeout(fn, 0),
    cwd: () => '/',
    argv: [],
    version: 'v18.0.0',
    versions: { node: '18.0.0' },
    platform: 'linux',
    arch: 'x64',
    release: { name: 'node' },
    execPath: '/usr/bin/node',
    pid: Math.floor(Math.random() * 10000) + 1,
    _events: new Map(),
    on(event, handler) {
        if (!this._events.has(event)) this._events.set(event, []);
        this._events.get(event).push(handler);
        return this;
    },
    once(event, handler) {
        const wrapped = (...args) => {
            this.off(event, wrapped);
            handler(...args);
        };
        return this.on(event, wrapped);
    },
    off(event, handler) {
        const list = this._events.get(event);
        if (!list) return this;
        this._events.set(event, list.filter(fn => fn !== handler));
        return this;
    },
    emit(event, ...args) {
        const list = this._events.get(event);
        if (!list) return false;
        list.forEach(fn => {
            try { fn(...args); } catch {}
        });
        return true;
    },
    exit(code = 0) {
        this.emit('exit', code);
        postMessage({ type: 'SYSCALL_LOG', payload: `Process exiting (${code})` });
        postMessage({ type: 'SYSCALL_PROC_EXIT', payload: { code } });
    },
    stdout: null,
    stderr: null,
    stdin: null
};

const pendingRequests = new Map();
let requestIdCounter = 0;
const tcpSockets = new Map();

// --- PATH UTILS ---
const pathUtils = {
    resolve: (p) => {
        const parts = p.split('/').filter(x => x && x !== '.');
        const stack = [];
        for (const part of parts) {
            if (part === '..') stack.pop();
            else stack.push(part);
        }
        return '/' + stack.join('/');
    },
    join: (...args) => pathUtils.resolve(args.join('/')),
    dirname: (p) => pathUtils.resolve(p + '/..'),
    extname: (p) => {
        const match = p.match(/\.[^/.]+$/);
        return match ? match[0] : '';
    },
    basename: (p, ext = '') => {
        const parts = p.split('/').filter(Boolean);
        let base = parts[parts.length - 1] || '';
        if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
        return base;
    },
    isAbsolute: (p) => p.startsWith('/'),
    normalize: (p) => pathUtils.resolve(p),
    sep: '/',
    delimiter: ':'
};

// --- BUILTINS REGISTRY ---
const BUILTINS = {
    'http': http,
    'fs': memfs,
    'path': pathUtils, // Use our lightweight path
    'buffer': { Buffer },
    'events': EventEmitter,
    'util': util,
    'url': {
        ...url,
        fileURLToPath: (input) => {
            const value = typeof input === 'string' ? input : (input && input.href ? input.href : '');
            if (!value) return '';
            if (value.startsWith('file://')) return decodeURIComponent(value.replace('file://', ''));
            return value;
        },
        pathToFileURL: (input) => {
            const path = typeof input === 'string' ? input : String(input || '');
            return { href: `file://${encodeURI(path)}` };
        }
    },
    'querystring': querystring,
    'stream': stream,
    'net': {},
    'crypto': {
        randomBytes: (size) => {
            const buf = new Uint8Array(size);
            crypto.getRandomValues(buf);
            return Buffer.from(buf);
        },
        createHash: () => {
            throw new Error('crypto.createHash not supported in web worker runtime');
        }
    },
    'zlib': {},
    'fs/promises': memfs.promises || {
        readFile: async (p, enc) => memfs.promises.readFile(p, enc),
        writeFile: async (p, data) => memfs.promises.writeFile(p, data),
        mkdir: async (p, opts) => memfs.promises.mkdir(p, opts),
        readdir: async (p, opts) => memfs.promises.readdir(p, opts),
        stat: async (p) => memfs.promises.stat(p),
        access: async (p) => memfs.promises.access(p),
        rm: async (p, opts) => memfs.promises.rm(p, opts)
    },
    'process': self.process,
    'child_process': {
        exec: (cmd, cb) => {
            const err = new Error('child_process.exec not supported in web worker runtime');
            if (cb) {
                setTimeout(() => cb(err, '', ''), 0);
                return { pid: 0 };
            }
            return { pid: 0 };
        },
        spawn: () => {
            const child = new EventEmitter();
            child.pid = 0;
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.stdin = new EventEmitter();
            setTimeout(() => {
                child.emit('error', new Error('child_process.spawn not supported in web worker runtime'));
                child.emit('close', 1);
                child.emit('exit', 1);
            }, 0);
            return child;
        }
    },
    'tty': { isatty: () => false },
    'os': {
        platform: () => 'webos',
        type: () => 'Linux',
        arch: () => 'x64',
        release: () => '0.0.0',
        hostname: () => 'webos',
        homedir: () => '/',
        tmpdir: () => '/tmp',
        EOL: '\n',
        cpus: () => [{ model: 'webos-cpu', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }]
    }
};

// --- REQUIRE SYSTEM ---
function makeRequire(baseDir) {
    return function require(moduleName) {
        if (moduleName.startsWith('node:')) moduleName = moduleName.slice(5);
        if (BUILTINS[moduleName]) return BUILTINS[moduleName];

        if (moduleName.startsWith('/')) {
            let fullPath = moduleName;
            if (!tryFile(fullPath)) {
                if (!fullPath.endsWith('.js') && tryFile(fullPath + '.js')) fullPath += '.js';
                else if (!fullPath.endsWith('.mjs') && tryFile(fullPath + '.mjs')) fullPath += '.mjs';
                else if (!fullPath.endsWith('.cjs') && tryFile(fullPath + '.cjs')) fullPath += '.cjs';
                else if (!fullPath.endsWith('.json') && tryFile(fullPath + '.json')) fullPath += '.json';
            }
            return loadModule(fullPath);
        }

        if (moduleName.startsWith('./') || moduleName.startsWith('../')) {
            let fullPath = pathUtils.join(baseDir, moduleName);
            if (!tryFile(fullPath)) {
                if (!fullPath.endsWith('.js') && tryFile(fullPath + '.js')) fullPath += '.js';
                else if (!fullPath.endsWith('.mjs') && tryFile(fullPath + '.mjs')) fullPath += '.mjs';
                else if (!fullPath.endsWith('.cjs') && tryFile(fullPath + '.cjs')) fullPath += '.cjs';
                else if (!fullPath.endsWith('.json') && tryFile(fullPath + '.json')) fullPath += '.json';
            }
            return loadModule(fullPath);
        }

        let current = baseDir;
        while (true) {
            const candidate = pathUtils.join(current, 'node_modules', moduleName);
            if (tryFile(candidate + '.js')) return loadModule(candidate + '.js');
            if (tryFile(candidate + '.mjs')) return loadModule(candidate + '.mjs');
            if (tryFile(candidate + '.cjs')) return loadModule(candidate + '.cjs');
            if (tryFile(candidate + '.json')) return loadModule(candidate + '.json');
            if (tryFile(pathUtils.join(candidate, 'index.js'))) return loadModule(pathUtils.join(candidate, 'index.js'));
            if (tryFile(pathUtils.join(candidate, 'index.mjs'))) return loadModule(pathUtils.join(candidate, 'index.mjs'));
            if (tryFile(pathUtils.join(candidate, 'index.cjs'))) return loadModule(pathUtils.join(candidate, 'index.cjs'));
            if (tryFile(pathUtils.join(candidate, 'index.json'))) return loadModule(pathUtils.join(candidate, 'index.json'));
            if (current === '/') break;
            current = pathUtils.resolve(current + '/..');
        }
        throw new Error(`Module '${moduleName}' not found from ${baseDir}`);
    }
}

function tryFile(path) {
    try { return memfs.existsSync(path); } catch(e) { return false; }
}

function detectESM(content) {
    return /^\s*import\s/m.test(content) || /^\s*export\s/m.test(content);
}

function transformESMToCJS(content, modulePath) {
    let output = content;
    const namedExports = [];
    let importCounter = 0;

    output = output.replace(/^\s*import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"];?\s*$/gm, (m, bindings, mod) => {
        const temp = `__m${importCounter++}`;
        const req = `require('${mod}')`;
        const parts = bindings.split(',').map(p => p.trim()).filter(Boolean);
        if (parts.length === 1) {
            const single = parts[0];
            if (single.startsWith('{')) {
                return `const ${single} = ${req};`;
            }
            if (single.startsWith('* as ')) {
                const name = single.replace('* as ', '').trim();
                return `const ${name} = ${req};`;
            }
            return `const ${temp} = ${req}; const ${single} = (${temp} && ${temp}.default) ? ${temp}.default : ${temp};`;
        }
        const def = parts[0];
        const named = parts[1];
        return `const ${temp} = ${req}; const ${def} = (${temp} && ${temp}.default) ? ${temp}.default : ${temp}; const ${named} = ${temp};`;
    });

    output = output.replace(/^\s*import\s+['"]([^'"]+)['"];?\s*$/gm, (m, mod) => {
        return `require('${mod}');`;
    });

    output = output.replace(/^\s*export\s+default\s+/gm, 'exports.default = ');

    output = output.replace(/^\s*export\s+\{([^}]+)\};?\s*$/gm, (m, names) => {
        const parts = names.split(',').map(p => p.trim()).filter(Boolean);
        const lines = [];
        for (const part of parts) {
            const [from, to] = part.split(/\s+as\s+/);
            const src = from.trim();
            const dest = (to || from).trim();
            lines.push(`exports.${dest} = ${src};`);
        }
        return lines.join('\n');
    });

    output = output.replace(/^\s*export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm, (m, kind, name) => {
        namedExports.push(name);
        return `${kind} ${name}`;
    });

    if (namedExports.length) {
        output += `\n${namedExports.map(name => `exports.${name} = ${name};`).join('\n')}\n`;
    }

    if (output.includes('import.meta')) {
        const fileUrl = modulePath ? `file://${modulePath}` : 'file:///entry.js';
        output = `const import_meta = { url: ${JSON.stringify(fileUrl)} }; const importMeta = import_meta;\n` +
            output.replace(/\bimport\.meta\b/g, 'import_meta');
    }

    return output;
}

function loadModule(path) {
    try {
        let content = memfs.readFileSync(path, 'utf8');
        if (content.startsWith('#!')) {
            const firstNewline = content.indexOf('\n');
            content = firstNewline === -1 ? '' : content.slice(firstNewline + 1);
        }

        if (path.endsWith('.json')) {
            return JSON.parse(content);
        }

        if (detectESM(content) || path.endsWith('.mjs')) {
            content = transformESMToCJS(content, path);
        }

        const module = { exports: {} };
        const moduleDir = pathUtils.dirname(path);
        const wrappedRequire = makeRequire(moduleDir);
        const hasFilename = /\b(const|let|var)\s+__filename\b/.test(content);
        const hasDirname = /\b(const|let|var)\s+__dirname\b/.test(content);
        const hasFilename2 = /\b(const|let|var)\s+_filename\b/.test(content);
        const hasDirname2 = /\b(const|let|var)\s+_dirname\b/.test(content);
        let header = '';
        if (!hasFilename && !hasFilename2) header += `const __filename = ${JSON.stringify(path)};\n`;
        if (!hasDirname && !hasDirname2) header += `const __dirname = ${JSON.stringify(moduleDir)};\n`;
        if (header) content = header + content;
        
        const needsAsync = /\bawait\b/.test(content);
        if (needsAsync) {
            const wrapper = new Function('require', 'module', 'exports', 'process', 'global', 'Buffer',
                `return (async () => {\n${content}\n})();`
            );
            const result = wrapper(wrappedRequire, module, module.exports, self.process, self, Buffer);
            if (result && typeof result.then === 'function') {
                if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') {
                if (!self.__pendingTopLevelAwait) self.__pendingTopLevelAwait = [];
                self.__pendingTopLevelAwait.push({ promise: result, path });
                } else {
                    waitForPromise(result);
                }
            }
        } else {
            // Wrap CJS
            const wrapper = new Function('require', 'module', 'exports', 'process', 'global', 'Buffer', content);
            wrapper(wrappedRequire, module, module.exports, self.process, self, Buffer);
        }
        return module.exports;
    } catch (e) {
        throw new Error(`Error loading ${path}: ${e.message}`);
    }
}

function waitForPromise(promise) {
    if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') {
        throw new Error('Top-level await requires SharedArrayBuffer/Atomics support');
    }
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    let error = null;
    promise.then(
        () => {
            Atomics.store(view, 0, 1);
            Atomics.notify(view, 0, 1);
        },
        (err) => {
            error = err;
            Atomics.store(view, 0, 1);
            Atomics.notify(view, 0, 1);
        }
    );
    while (Atomics.load(view, 0) === 0) {
        Atomics.wait(view, 0, 0, 1000);
    }
    if (error) throw error;
}

// ... (Keep existing syscall, os, onmessage code from previous answers) ...

// --- SYSCALL SETUP (Standard) ---
function syscall(type, payload = {}) {
    return new Promise((resolve, reject) => {
        const id = requestIdCounter++;
        pendingRequests.set(id, { resolve, reject });
        postMessage({ type, id, payload });
    });
}

const nativeFetch = self.fetch ? self.fetch.bind(self) : null;

function normalizeFetchOptions(options) {
    if (!options) return {};
    const out = { ...options };
    if (out.body && ArrayBuffer.isView(out.body)) {
        out.body = out.body.buffer;
    }
    return out;
}

function buildResponse(res) {
    const headers = new Headers(res.headers || {});
    const body = res.body ?? null;
    return new Response(body, { status: res.statusCode || 0, headers });
}

async function netFetch(url, options = {}) {
    const fixedOptions = normalizeFetchOptions(options);
    try {
        const res = await syscall('SYSCALL_NET_FETCH', { url, options: fixedOptions });
        return buildResponse(res);
    } catch (e) {
        if (nativeFetch) return nativeFetch(url, options);
        throw e;
    }
}

if (self.fetch) {
    self.fetch = netFetch;
}

function decodeBase64ToBuffer(data) {
    return Buffer.from(data, 'base64');
}

const netModule = (() => {
    class TcpSocket extends EventEmitter {
        constructor(host, port, connectListener, options = {}) {
            super();
            this.host = host;
            this.port = port;
            this.options = {
                ...options,
                insecure: options.insecure || options.rejectUnauthorized === false
            };
            this.streamId = null;
            this._closed = false;
            this._pendingWrites = [];
            if (connectListener) this.once('connect', connectListener);
            this._open();
        }

        async _open() {
            try {
                const res = await syscall('SYSCALL_NET_TCP_OPEN', {
                    host: this.host,
                    port: this.port,
                    options: this.options
                });
                this.streamId = res.streamId;
                tcpSockets.set(this.streamId, this);
                this.emit('connect');
                if (this._pendingWrites.length) {
                    for (const entry of this._pendingWrites) {
                        await this.write(entry.data, entry.encoding);
                    }
                    this._pendingWrites = [];
                }
            } catch (e) {
                this.emit('error', new Error(e));
            }
        }

        async write(data, encoding, cb) {
            if (this._closed) return;
            let buffer;
            if (typeof data === 'string') buffer = Buffer.from(data, encoding || 'utf8');
            else if (Buffer.isBuffer(data)) buffer = data;
            else if (ArrayBuffer.isView(data)) buffer = Buffer.from(data.buffer);
            else if (data instanceof ArrayBuffer) buffer = Buffer.from(data);
            else buffer = Buffer.from(String(data));

            if (!this.streamId) {
                this._pendingWrites.push({ data, encoding });
                return;
            }

            try {
                await syscall('SYSCALL_NET_TCP_WRITE', {
                    streamId: this.streamId,
                    data: buffer.toString('base64'),
                    dataEncoding: 'base64'
                });
                if (cb) cb();
            } catch (e) {
                this.emit('error', new Error(e));
                if (cb) cb(e);
            }
        }

        async end(data, encoding, cb) {
            if (data) await this.write(data, encoding);
            await this.destroy();
            if (cb) cb();
        }

        async destroy() {
            if (this._closed) return;
            this._closed = true;
            if (this.streamId) {
                try {
                    await syscall('SYSCALL_NET_TCP_CLOSE', { streamId: this.streamId });
                } catch {}
                tcpSockets.delete(this.streamId);
            }
            this.emit('close');
        }
    }

    function normalizeArgs(args) {
        if (typeof args[0] === 'object') {
            const opts = args[0] || {};
            return {
                port: opts.port || opts.remotePort,
                host: opts.host || opts.hostname || '127.0.0.1',
                cb: typeof args[1] === 'function' ? args[1] : null,
                options: opts
            };
        }
        return {
            port: args[0],
            host: typeof args[1] === 'string' ? args[1] : '127.0.0.1',
            cb: typeof args[1] === 'function' ? args[1] : (typeof args[2] === 'function' ? args[2] : null),
            options: {}
        };
    }

    return {
        createConnection: (...args) => {
            const { port, host, cb, options } = normalizeArgs(args);
            return new TcpSocket(host, port, cb, options);
        },
        connect: (...args) => {
            const { port, host, cb, options } = normalizeArgs(args);
            return new TcpSocket(host, port, cb, options);
        }
    };
})();

BUILTINS.net = netModule;
BUILTINS.tls = {
    connect: (...args) => {
        const opts = typeof args[0] === 'object' ? (args[0] || {}) : {};
        const host = typeof args[0] === 'object' ? (opts.host || opts.hostname) : (typeof args[1] === 'string' ? args[1] : '127.0.0.1');
        const port = typeof args[0] === 'object' ? (opts.port || opts.remotePort) : args[0];
        const cb = typeof args[1] === 'function' ? args[1] : (typeof args[2] === 'function' ? args[2] : null);
        const options = {
            ...opts,
            host,
            port,
            tls: true,
            serverName: opts.servername || opts.serverName || host,
            insecure: opts.rejectUnauthorized === false
        };
        return netModule.connect(options, cb);
    }
};

const os = {
    log: (...args) => postMessage({ type: 'SYSCALL_LOG', payload: args.join(' ') })
};
self.console.log = os.log;
self.console.error = (...args) => postMessage({ type: 'SYSCALL_TTY_WRITE', payload: { data: args.join(' ') + '\n', stream: 'stderr' } });

class Stdin extends EventEmitter {
    constructor() {
        super();
        this.isTTY = true;
        this._encoding = 'utf8';
        this._rawMode = false;
    }
    setEncoding(enc) { this._encoding = enc; }
    setRawMode(flag) { this._rawMode = !!flag; return this; }
    resume() {}
    pause() {}
    write(data) {
        this.emit('data', data);
    }
}

self.process.stdin = new Stdin();
self.process.stdout = new TtyStream('stdout');
self.process.stderr = new TtyStream('stderr');

self.onerror = (event) => {
    const msg = event && event.message ? event.message : 'Unknown error';
    postMessage({ type: 'SYSCALL_TTY_WRITE', payload: { data: `Unhandled error: ${msg}\n`, stream: 'stderr' } });
};

self.onunhandledrejection = (event) => {
    const reason = event && event.reason ? event.reason : 'Unknown rejection';
    postMessage({ type: 'SYSCALL_TTY_WRITE', payload: { data: `Unhandled rejection: ${reason}\n`, stream: 'stderr' } });
};

self.onmessage = async (event) => {
    const { type, id, payload } = event.data;

    if (type === 'SYSCALL_RESPONSE') {
        const request = pendingRequests.get(id);
        if (request) {
            if (event.data.error) request.reject(event.data.error);
            else request.resolve(event.data.result);
            pendingRequests.delete(id);
        }
        return;
    }

    if (type === 'NET_REQUEST') {
         if (self.__openPorts && self.__openPorts.has(payload.port)) {
            self.__openPorts.get(payload.port)(payload);
        } else {
            postMessage({ type: 'HTTP_RESPONSE', payload: { reqId: payload.reqId, statusCode: 502, body: "Port Closed" } });
        }
        return;
    }

    if (type === 'NET_TCP_DATA') {
        const socket = tcpSockets.get(payload.streamId);
        if (socket) {
            const buf = payload.dataEncoding === 'base64'
                ? decodeBase64ToBuffer(payload.data)
                : Buffer.from(payload.data || '');
            socket.emit('data', buf);
        }
        return;
    }

    if (type === 'NET_TCP_CLOSE') {
        const socket = tcpSockets.get(payload.streamId);
        if (socket) {
            if (payload.error) socket.emit('error', new Error(payload.error));
            socket.emit('close');
            tcpSockets.delete(payload.streamId);
        }
        return;
    }

    if (type === 'TTY_INPUT') {
        const data = payload && payload.data ? payload.data : '';
        self.process.stdin.write(data);
        return;
    }

    if (type === 'WRITE_VIRTUAL_FILE') {
        const { path, kind, content } = payload;
        try {
            if (kind === 'directory') {
                memfs.mkdirSync(path, { recursive: true });
            } else {
                const dir = pathUtils.dirname(path);
                if (dir !== '/' && dir !== '.') memfs.mkdirSync(dir, { recursive: true });
                const buf = Buffer.from(content); 
                memfs.writeFileSync(path, buf);
            }
        } catch (e) {
            os.log(`[FS Sync] Error on ${path}: ${e.message}`);
        }
        return;
    }

    if (type === 'EXEC_CODE') {
        try {
            let userCode = payload;
            let currentPath = '/entry.js';
            if (typeof payload === 'object' && payload.code) {
                userCode = payload.code;
                currentPath = payload.path || '/entry.js';
            }
            const currentDir = pathUtils.dirname(currentPath);

            // Update CWD dynamically
            self.process.cwd = () => currentDir;

            const rootRequire = makeRequire(currentDir);

            const factory = new Function('require', 'process', 'console', 'Buffer', 'module', 'exports', `
                return (async () => { 
                    ${userCode} 
                })();
            `);
            
            const module = { exports: {} };
            await factory(rootRequire, self.process, self.console, Buffer, module, module.exports);

            if (self.__pendingTopLevelAwait && self.__pendingTopLevelAwait.length) {
                try {
                    const pending = self.__pendingTopLevelAwait.slice();
                    const results = await Promise.allSettled(pending.map(p => p.promise));
                    results.forEach((res, idx) => {
                        if (res.status === 'rejected') {
                            const info = pending[idx];
                            os.log(`Top-level await failed in ${info.path}: ${res.reason}`);
                        }
                    });
                } finally {
                    self.__pendingTopLevelAwait = [];
                }
            }
            
        } catch (err) {
            os.log(`Runtime Error: ${err.message}`);
            console.error(err);
        }
    }
};
