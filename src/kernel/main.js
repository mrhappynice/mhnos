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

const OS = {
    wm: new WindowManager('desktop'),
    shell: null,
    procs: new Map(),
    pidCounter: 1,
    ports: new Map(),

    // --- LOOPBACK FETCH (Updated for Binary) ---
    fetch: (url) => {
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
            window: null
        });

        setupWorkerListeners(worker, pid);
        audio.init();

        await syncFileSystem(worker); // Ensure this function is the one from previous step

        // UPDATE: Send object with code AND path
        worker.postMessage({ type: 'EXEC_CODE', payload: { code, path } });
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

// --- FILE SYNC HELPER ---
async function syncFileSystem(worker) {
    // 1. Get the entire tree from OPFS
    const tree = await fs.getFullTree(); 
    
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

OS.shell = new Shell(OS);

installStaticFiles(OS.shell);

OS.launcher = new LauncherApp(OS);
OS.launcher.open();

function setupWorkerListeners(worker, pid) {
    worker.onmessage = async (event) => {
        const { type, payload, id } = event.data;
        const send = (res, err, trans) => {
            if(OS.procs.has(pid)) worker.postMessage({ type: 'SYSCALL_RESPONSE', id, result: res, error: err }, trans);
        };

        switch (type) {
            case 'SYSCALL_LOG': OS.shell.print(`[${pid}] ${payload}`); break;
            case 'SYSCALL_NET_LISTEN':
                if (OS.ports.has(payload.port)) OS.shell.print(`[NET] Port ${payload.port} busy`, 'error');
                else {
                    OS.ports.set(payload.port, pid);
                    OS.procs.get(pid).ports.add(payload.port);
                    OS.shell.print(`[NET] Process ${pid} listening :${payload.port}`, 'success');
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
        }
    };
}
