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
self.process = {
    env: { NODE_ENV: 'development' },
    nextTick: (fn) => setTimeout(fn, 0),
    cwd: () => '/',
    argv: [],
    version: 'v16.0.0',
    platform: 'linux',
    stdout: { write: (msg) => console.log(msg) },
    stderr: { write: (msg) => console.log(msg) }
};

const pendingRequests = new Map();
let requestIdCounter = 0;

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
    }
};

// --- BUILTINS REGISTRY ---
const BUILTINS = {
    'http': http,
    'fs': memfs,
    'path': pathUtils, // Use our lightweight path
    'buffer': { Buffer },
    'events': EventEmitter,
    'util': util,
    'url': url,
    'querystring': querystring,
    'stream': stream,
    'net': {},
    'crypto': {},
    'zlib': {},
    'tty': { isatty: () => false },
    'os': { platform: () => 'webos', EOL: '\n', type: () => 'Linux' }
};

// --- REQUIRE SYSTEM ---
function makeRequire(baseDir) {
    return function require(moduleName) {
        if (BUILTINS[moduleName]) return BUILTINS[moduleName];

        if (moduleName.startsWith('./') || moduleName.startsWith('../')) {
            let fullPath = pathUtils.join(baseDir, moduleName);
            if (!fullPath.endsWith('.js')) fullPath += '.js';
            return loadModule(fullPath);
        }

        let current = baseDir;
        while (true) {
            const candidate = pathUtils.join(current, 'node_modules', moduleName);
            if (tryFile(candidate + '.js')) return loadModule(candidate + '.js');
            if (tryFile(pathUtils.join(candidate, 'index.js'))) return loadModule(pathUtils.join(candidate, 'index.js'));
            if (current === '/') break;
            current = pathUtils.resolve(current + '/..');
        }
        throw new Error(`Module '${moduleName}' not found from ${baseDir}`);
    }
}

function tryFile(path) {
    try { return memfs.existsSync(path); } catch(e) { return false; }
}

function loadModule(path) {
    try {
        const content = memfs.readFileSync(path, 'utf8');
        const module = { exports: {} };
        const moduleDir = pathUtils.dirname(path);
        const wrappedRequire = makeRequire(moduleDir);
        
        // Wrap CJS
        const wrapper = new Function('require', 'module', 'exports', '__dirname', '__filename', 'process', 'global', 'Buffer', content);
        wrapper(wrappedRequire, module, module.exports, moduleDir, path, self.process, self, Buffer);
        return module.exports;
    } catch (e) {
        throw new Error(`Error loading ${path}: ${e.message}`);
    }
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

const os = {
    log: (...args) => postMessage({ type: 'SYSCALL_LOG', payload: args.join(' ') })
};
self.console.log = os.log;

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
            
        } catch (err) {
            os.log(`Runtime Error: ${err.message}`);
            console.error(err);
        }
    }
};
