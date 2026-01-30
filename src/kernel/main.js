// src/kernel/main.js
import * as fs from './fs.js';
import * as audio from './audio.js';
import { WindowManager } from '../system/wm.js';
import { Shell } from '../system/shell.js';
import { installStaticFiles } from '../system/boot.js'; 
import { LauncherApp } from '../system/apps.js';

const NETWORK = {
    pendingRequests: new Map(),
    reqIdCounter: 0
};

const NET = {
    mode: 'direct', // direct | proxy | worker
    proxyUrl: 'ws://localhost:5772',
    ws: null,
    wsConnecting: null,
    pending: new Map(),
    tcpStreams: new Map(),
    reqIdCounter: 1,
    lastError: null
};

const OS = {
    wm: new WindowManager('desktop'),
    shell: null,
    procs: new Map(),
    pidCounter: 1,
    ports: new Map(),
    net: NET,
    ttyAttachedPid: null,

    // --- FETCH API (Loopback + External) ---
    fetch: (url, options = {}) => {
        if (isLocalhostUrl(url)) return loopbackFetch(url);
        return netFetch(url, options);
    },

    loopbackFetch: (url) => loopbackFetch(url),

    netFetch: (url, options = {}) => netFetch(url, options),

    setNetMode: (mode) => {
        NET.mode = mode;
        if (mode !== 'proxy') closeProxySocket();
    },

    setProxyUrl: (url) => {
        NET.proxyUrl = url;
        closeProxySocket();
    },

    getNetStatus: () => ({
        mode: NET.mode,
        proxyUrl: NET.proxyUrl,
        proxyState: NET.ws ? NET.ws.readyState : null,
        lastError: NET.lastError
    }),

    attachTty: (pid, sink = null) => {
        OS.ttyAttachedPid = pid;
        OS.ttySink = typeof sink === 'function' ? sink : null;
        const proc = OS.procs.get(pid);
        if (proc && OS.ttySink && proc.ttyBuffer && proc.ttyBuffer.length) {
            proc.ttyBuffer.forEach(payload => OS.ttySink(payload));
        }
    },

    detachTty: () => {
        OS.ttyAttachedPid = null;
        OS.ttySink = null;
    },

    sendTtyInput: (pid, data) => {
        const proc = OS.procs.get(pid);
        if (!proc) return;
        proc.worker.postMessage({ type: 'TTY_INPUT', payload: { data } });
    },

    // --- SPAWN PROCESS ---
    spawn: async (code, path = "/process.js") => {
        const pid = OS.pidCounter++;
        const worker = new Worker('./src/runtime/worker.js', { type: "module" });
        
        worker.onerror = (e) => {
            OS.shell.print(`[KERNEL] Process ${pid} Crashed: ${e.message}`, 'error');
            console.error(e);
        };

        OS.procs.set(pid, {
            id: pid,
            worker: worker,
            startTime: Date.now(),
            name: path,
            ports: new Set(),
            window: null,
            ttyBuffer: [],
            ttyBufferSize: 0
        });

        setupWorkerListeners(worker, pid);
        audio.init();

        await syncFileSystem(worker); // Ensure this function is the one from previous step

        // UPDATE: Send object with code AND path
        worker.postMessage({ type: 'EXEC_CODE', payload: { code, path } });
        return pid;
    },
    
    // --- SPAWN PYTHON PROCESS ---
spawnPython: async (code, path = "/process.py") => {
    const pid = OS.pidCounter++;

    // IMPORTANT: classic worker (no { type: "module" }) so python-worker can importScripts()
    const worker = new Worker('./src/runtime/python-worker.js');

    worker.onerror = (e) => {
        OS.shell.print(`[KERNEL] Python Process ${pid} Crashed: ${e.message}`, 'error');
        console.error(e);
    };

    OS.procs.set(pid, {
        id: pid,
        worker: worker,
        startTime: Date.now(),
        name: path,
        ports: new Set(),
        window: null,
        ttyBuffer: [],
        ttyBufferSize: 0
    });

    setupWorkerListeners(worker, pid);
    audio.init();

    // If your python-worker mounts OPFS via pyodide.mountNativeFS, you can skip syncing.
    // If you decide NOT to mount OPFS, keep this:
    // await syncFileSystem(worker);

    worker.postMessage({ type: 'EXEC_PY', payload: { code, path } });
    return pid;
},


    kill: (pid) => {
        if (OS.procs.has(pid)) {
            const proc = OS.procs.get(pid);
            proc.worker.terminate();
            if (proc.window) OS.wm.closeWindow(proc.window);
            proc.ports.forEach(p => OS.ports.delete(p));
            OS.procs.delete(pid);
            OS.shell.print(`[KERNEL] Process ${pid} terminated.`, 'system');
        }
    }
};

let esbuildPromise = null;

function normalizePath(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    const stack = [];
    for (const part of parts) {
        if (part === '.') continue;
        if (part === '..') stack.pop();
        else stack.push(part);
    }
    return '/' + stack.join('/');
}

function dirname(path) {
    if (!path || path === '/') return '/';
    const idx = path.lastIndexOf('/');
    if (idx <= 0) return '/';
    return path.slice(0, idx);
}

async function statPath(path) {
    const res = await fs.stat(path);
    if (res && res.success) return res.data;
    return { exists: false, isDir: false };
}

async function resolveWithExtensions(path) {
    const candidates = [
        path,
        `${path}.ts`,
        `${path}.tsx`,
        `${path}.js`,
        `${path}.jsx`,
        `${path}.mjs`,
        `${path}.cjs`,
        `${path}.json`
    ];
    for (const candidate of candidates) {
        const s = await statPath(candidate);
        if (s.exists && !s.isDir) return candidate;
    }
    const dirStat = await statPath(path);
    if (dirStat.exists && dirStat.isDir) {
        const indexCandidates = [
            `${path}/index.tsx`,
            `${path}/index.ts`,
            `${path}/index.jsx`,
            `${path}/index.js`,
            `${path}/index.mjs`
        ];
        for (const candidate of indexCandidates) {
            const s = await statPath(candidate);
            if (s.exists && !s.isDir) return candidate;
        }
    }
    return null;
}

function parsePackageName(spec) {
    if (spec.startsWith('@')) {
        const parts = spec.split('/');
        return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
    }
    return spec.split('/')[0];
}

function parseSubpath(spec, pkgName) {
    if (spec === pkgName) return '';
    if (spec.startsWith(pkgName + '/')) return spec.slice(pkgName.length + 1);
    return '';
}

function pickExportTarget(target) {
    if (!target) return null;
    if (typeof target === 'string') return target;
    if (typeof target === 'object') {
        return target.import || target.browser || target.default || target.module || target.require || null;
    }
    return null;
}

async function resolvePackageEntry(pkgRoot, pkgJson, subpath) {
    let entryRel = null;
    const exportsField = pkgJson && pkgJson.exports;
    if (exportsField) {
        if (subpath) {
            const key = `./${subpath}`;
            entryRel = pickExportTarget(exportsField[key]);
        } else {
            entryRel = pickExportTarget(exportsField['.'] || exportsField);
        }
    }
    if (!entryRel) {
        if (subpath) entryRel = subpath;
        else entryRel = pkgJson.browser || pkgJson.module || pkgJson.main || 'index.js';
    }
    if (!entryRel) return null;
    const fullPath = normalizePath(`${pkgRoot}/${entryRel}`);
    return await resolveWithExtensions(fullPath);
}

async function resolveBarePath(spec, appRoot) {
    const pkgName = parsePackageName(spec);
    const subpath = parseSubpath(spec, pkgName);
    const appNodeModules = `${appRoot}/node_modules/${pkgName}`;
    const globalNodeModules = `/usr/lib/node_modules/${pkgName}`;
    const globalSingleFile = `/usr/lib/node_modules/${pkgName}.js`;

    const appStat = await statPath(appNodeModules);
    const pkgRoot = appStat.exists && appStat.isDir ? appNodeModules : globalNodeModules;
    const pkgRootStat = await statPath(pkgRoot);
    if (!pkgRootStat.exists) {
        const fileStat = await statPath(globalSingleFile);
        if (fileStat.exists && !fileStat.isDir) return globalSingleFile;
        throw new Error(`Package not found: ${pkgName}`);
    }

    let pkgJson = {};
    try {
        const res = await fs.readFile(`${pkgRoot}/package.json`, true);
        if (res && res.success && res.data) pkgJson = JSON.parse(res.data);
    } catch {}

    const entryPath = await resolvePackageEntry(pkgRoot, pkgJson, subpath);
    if (!entryPath) throw new Error(`Entry not found for ${spec}`);
    return entryPath;
}

function guessLoader(path) {
    const lower = path.toLowerCase();
    if (lower.endsWith('.tsx')) return 'tsx';
    if (lower.endsWith('.ts')) return 'ts';
    if (lower.endsWith('.tsc')) return 'ts';
    if (lower.endsWith('.jsx')) return 'jsx';
    if (lower.endsWith('.json')) return 'json';
    return 'js';
}

async function ensureEsbuild() {
    if (esbuildPromise) return esbuildPromise;
    esbuildPromise = (async () => {
        if (!window.esbuild) {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = '/vendor/esbuild-wasm.js';
                script.onload = () => resolve();
                script.onerror = () => reject(new Error('Failed to load /vendor/esbuild-wasm.js'));
                document.head.appendChild(script);
            });
        }
        const esbuild = window.esbuild;
        if (!esbuild) throw new Error('esbuild not available on window');
        await esbuild.initialize({ wasmURL: '/vendor/esbuild-wasm.wasm', worker: false });
        return esbuild;
    })();
    return esbuildPromise;
}

function isLocalhostUrl(url) {
    return typeof url === 'string' && /^(https?:\/\/)?localhost:\d+/.test(url);
}

function normalizeUrl(url) {
    if (typeof url !== 'string') return url;
    if (url.startsWith('/')) return url;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (isLocalhostUrl(url)) return url.replace(/^https?:\/\//, '');
    return `https://${url}`;
}

function loopbackFetch(url) {
    return new Promise((resolve) => {
        const match = url.match(/localhost:(\d+)(.*)/);
        if (!match) {
            resolve({ statusCode: 400, body: "Invalid URL" });
            return;
        }

        const port = parseInt(match[1]);
        const path = match[2] || '/';
        
        if (!OS.ports.has(port)) {
            resolve({ statusCode: 502, body: "Connection Refused" });
            return;
        }

        const targetPid = OS.ports.get(port);
        const targetProc = OS.procs.get(targetPid);
        
        if (!targetProc) {
            OS.ports.delete(port);
            resolve({ statusCode: 502, body: "Process Dead" });
            return;
        }

        const reqId = NETWORK.reqIdCounter++;
        NETWORK.pendingRequests.set(reqId, resolve);

        targetProc.worker.postMessage({
            type: 'NET_REQUEST',
            payload: { port, method: 'GET', url: path, reqId }
        });
    });
}

function headersToObject(headers) {
    const out = {};
    if (!headers) return out;
    for (const [k, v] of headers.entries()) out[k.toLowerCase()] = v;
    return out;
}

function isTextContentType(contentType) {
    if (!contentType) return false;
    return contentType.startsWith('text/') ||
        contentType.includes('application/json') ||
        contentType.includes('application/javascript') ||
        contentType.includes('application/xml') ||
        contentType.includes('application/xhtml+xml');
}

async function directFetch(url, options = {}) {
    const res = await fetch(normalizeUrl(url), options);
    const headers = headersToObject(res.headers);
    const contentType = headers['content-type'] || '';
    let body;
    if (options.responseType === 'arraybuffer') {
        body = await res.arrayBuffer();
    } else if (options.responseType === 'text' || isTextContentType(contentType)) {
        body = await res.text();
    } else {
        body = await res.arrayBuffer();
    }
    return { statusCode: res.status, headers, body };
}

function closeProxySocket() {
    if (NET.ws) {
        try { NET.ws.close(); } catch {}
        NET.ws = null;
    }
    NET.wsConnecting = null;
}

function ensureProxySocket() {
    if (!NET.proxyUrl) return Promise.reject(new Error('Proxy URL not set'));
    if (NET.ws && NET.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (NET.wsConnecting) return NET.wsConnecting;

    NET.ws = new WebSocket(NET.proxyUrl);
    NET.ws.binaryType = 'arraybuffer';

    NET.ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'fetch') {
                const pending = NET.pending.get(msg.id);
                if (!pending) return;
                NET.pending.delete(msg.id);
                if (msg.error) {
                    pending.reject(new Error(msg.error));
                    return;
                }
                const body = decodeProxyBody(msg.body, msg.bodyEncoding);
                pending.resolve({ statusCode: msg.status || 200, headers: msg.headers || {}, body });
                return;
            }
            if (msg.type === 'tcp_open' || msg.type === 'tcp_write') {
                const pending = NET.pending.get(msg.id);
                if (!pending) return;
                NET.pending.delete(msg.id);
                if (msg.ok === false || msg.error) {
                    pending.reject(new Error(msg.error || 'TCP error'));
                    return;
                }
                pending.resolve(msg);
                return;
            }
            if (msg.type === 'tcp_data') {
                const info = NET.tcpStreams.get(msg.streamId);
                if (!info) return;
                const proc = OS.procs.get(info.pid);
                if (!proc) return;
                proc.worker.postMessage({
                    type: 'NET_TCP_DATA',
                    payload: { streamId: msg.streamId, data: msg.data, dataEncoding: msg.dataEncoding }
                });
                return;
            }
            if (msg.type === 'tcp_close') {
                const info = NET.tcpStreams.get(msg.streamId);
                NET.tcpStreams.delete(msg.streamId);
                if (!info) return;
                const proc = OS.procs.get(info.pid);
                if (!proc) return;
                proc.worker.postMessage({
                    type: 'NET_TCP_CLOSE',
                    payload: { streamId: msg.streamId, error: msg.error || null }
                });
                return;
            }
        } catch (e) {
            NET.lastError = e.message;
        }
    };

    NET.ws.onclose = () => {
        NET.ws = null;
        const pending = Array.from(NET.pending.values());
        NET.pending.clear();
        pending.forEach(p => p.reject(new Error('Proxy connection closed')));
    };

    NET.ws.onerror = () => {
        NET.lastError = 'Proxy socket error';
    };

    NET.wsConnecting = new Promise((resolve, reject) => {
        NET.ws.onopen = () => {
            NET.wsConnecting = null;
            resolve();
        };
        NET.ws.onerror = () => {
            NET.wsConnecting = null;
            reject(new Error('Proxy connection failed'));
        };
    });

    return NET.wsConnecting;
}

function encodeProxyBody(body) {
    if (!body) return { body: null, bodyEncoding: null };
    if (body instanceof ArrayBuffer) {
        return { body: arrayBufferToBase64(body), bodyEncoding: 'base64' };
    }
    if (ArrayBuffer.isView(body)) {
        return { body: arrayBufferToBase64(body.buffer), bodyEncoding: 'base64' };
    }
    if (typeof body === 'string') {
        return { body, bodyEncoding: 'utf8' };
    }
    return { body: JSON.stringify(body), bodyEncoding: 'json' };
}

function decodeProxyBody(body, encoding) {
    if (!body) return '';
    if (encoding === 'base64') return base64ToArrayBuffer(body);
    if (encoding === 'json') return body;
    return body;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

async function proxyFetch(url, options = {}) {
    await ensureProxySocket();
    return new Promise((resolve, reject) => {
        const id = NET.reqIdCounter++;
        const payload = encodeProxyBody(options.body);
        NET.pending.set(id, { resolve, reject });
        NET.ws.send(JSON.stringify({
            type: 'fetch',
            id,
            url: normalizeUrl(url),
            method: (options.method || 'GET').toUpperCase(),
            headers: options.headers || {},
            body: payload.body,
            bodyEncoding: payload.bodyEncoding
        }));
    });
}

async function proxyTcpOpen(host, port, pid, options = {}) {
    await ensureProxySocket();
    return new Promise((resolve, reject) => {
        const id = NET.reqIdCounter++;
        NET.pending.set(id, { resolve, reject });
        NET.ws.send(JSON.stringify({
            type: 'tcp_open',
            id,
            host,
            port,
            tls: !!options.tls,
            serverName: options.serverName || options.servername || null,
            insecure: !!options.insecure
        }));
    }).then((res) => {
        if (res && res.streamId) {
            NET.tcpStreams.set(res.streamId, { pid });
        }
        return res;
    });
}

async function proxyTcpWrite(streamId, data, dataEncoding) {
    await ensureProxySocket();
    return new Promise((resolve, reject) => {
        const id = NET.reqIdCounter++;
        NET.pending.set(id, { resolve, reject });
        NET.ws.send(JSON.stringify({
            type: 'tcp_write',
            id,
            streamId,
            data,
            dataEncoding
        }));
    });
}

async function proxyTcpClose(streamId) {
    await ensureProxySocket();
    NET.ws.send(JSON.stringify({
        type: 'tcp_close',
        id: 0,
        streamId
    }));
    NET.tcpStreams.delete(streamId);
}

async function netFetch(url, options = {}) {
    if (NET.mode === 'direct') return directFetch(url, options);
    if (NET.mode === 'proxy') return proxyFetch(url, options);
    return { statusCode: 501, headers: {}, body: 'Network mode not implemented' };
}

// --- FILE SYNC HELPER ---
async function syncFileSystem(worker) {
    // 1. Get the entire tree from OPFS
    let tree = [];
    try {
        tree = await fs.getFullTree();
    } catch (e) {
        OS.shell.print(`[KERNEL] File sync disabled: ${e.message}`, 'system');
        return;
    }
    
    if (tree.length > 0) {
        OS.shell.print(`[KERNEL] Syncing filesystem objects...`, 'system');
        
        // 2. Sort so directories are created before files
        tree.sort((a, b) => (a.kind === 'directory' ? -1 : 1));

        for (const node of tree) {
            if (node.kind === 'directory') {
                // Tell worker to mkdir
                worker.postMessage({
                    type: 'WRITE_VIRTUAL_FILE',
                    payload: { path: node.path, kind: 'directory' }
                });
            } else {
                // Read content and send
                const file = await node.handle.getFile();
                const arrayBuffer = await file.arrayBuffer();
                
                worker.postMessage({
                    type: 'WRITE_VIRTUAL_FILE',
                    payload: { path: node.path, kind: 'file', content: arrayBuffer }
                }, [arrayBuffer]); // Transfer
            }
        }
    }
}

async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
        OS.shell?.print('[SW] Service workers not supported', 'system');
        return null;
    }
    try {
        const reg = await navigator.serviceWorker.register('/mhnos-sw.js?v=18', { scope: '/' });
        await navigator.serviceWorker.ready;
        OS.shell?.print('[SW] Registered /mhnos-sw.js', 'success');
        try {
            if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'SW_KERNEL_READY' });
            }
        } catch {}
        if (!navigator.serviceWorker.controller) {
            try {
                const key = 'mhnos_sw_reload_once';
                if (!sessionStorage.getItem(key)) {
                    sessionStorage.setItem(key, '1');
                    location.reload();
                    return reg;
                }
            } catch {}
        }
        return reg;
    } catch (e) {
        OS.shell?.print(`[SW] Registration failed: ${e.message}`, 'error');
        return null;
    }
}

function setupServiceWorkerRpc() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', async (event) => {
        const msg = event.data || {};
        if (msg.type === 'SW_LOG') {
            const level = msg.level || 'system';
            OS.shell?.print(`[SW] ${msg.message || ''}`, level === 'error' ? 'error' : 'system');
            return;
        }
        if (msg.type !== 'SW_RPC_REQUEST') return;
        const { id, method, params } = msg;
        const respond = (ok, data, error) => {
            try {
                event.source?.postMessage({ type: 'SW_RPC_RESPONSE', id, ok, data, error });
            } catch (e) {
                console.warn('[SW_RPC] response failed', e);
            }
        };

        try {
            if (method === 'fs.readFile') {
                const res = await fs.readFile(params.path, !!params.asText);
                respond(!!res.success, res.data ?? null, res.error);
                return;
            }
            if (method === 'fs.writeFile') {
                const res = await fs.writeFile(params.path, params.content);
                respond(!!res.success, res.data ?? null, res.error);
                return;
            }
            if (method === 'fs.listDir') {
                const res = await fs.listFiles(params.path || '/');
                respond(!!res.success, res.data ?? [], res.error);
                return;
            }
            if (method === 'fs.stat') {
                const res = await fs.stat(params.path);
                respond(!!res.success, res.data ?? null, res.error);
                return;
            }
            if (method === 'tool.transform') {
                const esbuild = await ensureEsbuild();
                const result = await esbuild.transform(params.code || '', {
                    loader: params.loader || 'js',
                    sourcemap: 'inline',
                    format: 'esm',
                    platform: 'browser',
                    sourcefile: params.sourcefile || ''
                });
                respond(true, { code: result.code || '', map: result.map || '' }, null);
                return;
            }
            if (method === 'tool.bundle') {
                const esbuild = await ensureEsbuild();
                const entryPath = params.entryPath;
                const appRoot = params.appRoot || '/apps';
                const plugin = {
                    name: 'opfs-resolver',
                    setup(build) {
                        build.onResolve({ filter: /.*/ }, async (args) => {
                            if (args.path.startsWith('http://') || args.path.startsWith('https://')) {
                                return { path: args.path, external: true };
                            }
                            if (args.path.startsWith('.') || args.path.startsWith('/')) {
                                const resolved = args.path.startsWith('.')
                                    ? normalizePath(`${args.resolveDir || '/'}${args.path.startsWith('.') ? '/' : ''}${args.path}`)
                                    : normalizePath(args.path);
                                const withExt = await resolveWithExtensions(resolved);
                                return { path: withExt || resolved, namespace: 'opfs' };
                            }
                            const resolvedBare = await resolveBarePath(args.path, appRoot);
                            return { path: resolvedBare, namespace: 'opfs' };
                        });
                        build.onLoad({ filter: /.*/, namespace: 'opfs' }, async (args) => {
                            const res = await fs.readFile(args.path, true);
                            const contents = res && res.success ? res.data : '';
                            const loader = guessLoader(args.path);
                            return { contents, loader, resolveDir: dirname(args.path) };
                        });
                    }
                };
                const result = await esbuild.build({
                    entryPoints: [entryPath],
                    bundle: true,
                    format: 'esm',
                    platform: 'browser',
                    write: false,
                    sourcemap: false,
                    plugins: [plugin]
                });
                const output = result.outputFiles && result.outputFiles[0];
                if (!output) throw new Error('Bundle failed: no output');
                respond(true, { code: output.text || '' }, null);
                return;
            }
            respond(false, null, `unknown method: ${method}`);
        } catch (e) {
            respond(false, null, e.message || String(e));
        }
    });
}

async function boot() {
    OS.shell = new Shell(OS);
    setupServiceWorkerRpc();
    await registerServiceWorker();
    installStaticFiles(OS.shell);
    OS.launcher = new LauncherApp(OS);
    OS.launcher.open();
}

boot();

function setupWorkerListeners(worker, pid) {
    worker.onmessage = async (event) => {
        const { type, payload, id } = event.data;
        const send = (res, err, trans) => {
            if(OS.procs.has(pid)) worker.postMessage({ type: 'SYSCALL_RESPONSE', id, result: res, error: err }, trans);
        };

        switch (type) {
            case 'SYSCALL_LOG': OS.shell.print(`[${pid}] ${payload}`); break;
            case 'SYSCALL_TTY_WRITE':
                if (OS.procs.has(pid)) {
                    const proc = OS.procs.get(pid);
                    const entry = { data: payload.data, stream: payload.stream };
                    proc.ttyBuffer.push(entry);
                    proc.ttyBufferSize += String(payload.data || '').length;
                    while (proc.ttyBufferSize > 20000 && proc.ttyBuffer.length) {
                        const removed = proc.ttyBuffer.shift();
                        proc.ttyBufferSize -= String(removed.data || '').length;
                    }
                }
                if (OS.ttyAttachedPid === pid && OS.ttySink) {
                    OS.ttySink(payload);
                } else {
                    OS.shell.print(`[${pid}] ${payload.data}`, payload.stream === 'stderr' ? 'error' : '');
                }
                break;
            case 'SYSCALL_NET_LISTEN':
                if (OS.ports.has(payload.port)) OS.shell.print(`[NET] Port ${payload.port} busy`, 'error');
                else {
                    OS.ports.set(payload.port, pid);
                    OS.procs.get(pid).ports.add(payload.port);
                    OS.shell.print(`[NET] Process ${pid} listening :${payload.port}`, 'success');
                }
                break;
            case 'SYSCALL_NET_FETCH':
                try {
                    const res = await OS.netFetch(payload.url, payload.options || {});
                    const body = res.body;
                    const transfer = body instanceof ArrayBuffer
                        ? [body]
                        : (body && body.buffer instanceof ArrayBuffer ? [body.buffer] : []);
                    send(res, null, transfer);
                } catch (e) {
                    send(null, e.message || String(e));
                }
                break;
            case 'SYSCALL_NET_TCP_OPEN':
                try {
                    if (OS.net.mode !== 'proxy') throw new Error('TCP requires proxy mode');
                    const res = await proxyTcpOpen(payload.host, payload.port, pid, payload.options || {});
                    send({ streamId: res.streamId }, null);
                } catch (e) {
                    send(null, e.message || String(e));
                }
                break;
            case 'SYSCALL_NET_TCP_WRITE':
                try {
                    if (OS.net.mode !== 'proxy') throw new Error('TCP requires proxy mode');
                    await proxyTcpWrite(payload.streamId, payload.data, payload.dataEncoding);
                    send({ ok: true }, null);
                } catch (e) {
                    send(null, e.message || String(e));
                }
                break;
            case 'SYSCALL_NET_TCP_CLOSE':
                try {
                    if (OS.net.mode !== 'proxy') throw new Error('TCP requires proxy mode');
                    await proxyTcpClose(payload.streamId);
                    send({ ok: true }, null);
                } catch (e) {
                    send(null, e.message || String(e));
                }
                break;
            case 'HTTP_RESPONSE':
                // Payload now contains 'body' which might be ArrayBuffer or String
                const req = NETWORK.pendingRequests.get(payload.reqId);
                if (req) {
                    req(payload);
                    NETWORK.pendingRequests.delete(payload.reqId);
                }
                break;
            case 'SYSCALL_FS_READ':
                // Shell/Nano usually want text, but we support both now
                const r = await fs.readFile(payload.filename, true); // defaulting to text for user apps for now
                send(r.success ? r.data : null, r.error);
                break;
            case 'SYSCALL_FS_WRITE':
                // Write as text or binary? For now, text from Shell
                send(await fs.writeFile(payload.filename, payload.content));
                break;
            case 'SYSCALL_FS_LIST':
                const l = await fs.listFiles();
                send(l.success ? l.data : [], l.error);
                break;
            case 'SYSCALL_PROC_EXIT':
                OS.shell.print(`[KERNEL] Process ${pid} exited (${payload.code ?? 0}).`, 'system');
                OS.kill(pid);
                break;
        }
    };
}
