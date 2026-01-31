// src/kernel/fs.js

let rootHandle = null;

async function getRoot() {
    if (rootHandle) return rootHandle;
    try {
        rootHandle = await navigator.storage.getDirectory();
        return rootHandle;
    } catch (err) {
        throw new Error(`OPFS unavailable: ${err.message}`);
    }
}

// --- PATH UTILS ---
// specific to OPFS handling
async function resolveHandle(path, create = false, type = 'file') {
    let current = await getRoot();
    const parts = path.split('/').filter(p => p !== '' && p !== '.');
    
    // Traverse directories
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        try {
            current = await current.getDirectoryHandle(part, { create: create });
        } catch (e) {
            throw new Error(`Directory not found: ${part}`);
        }
    }

    const last = parts[parts.length - 1];
    if (!last) return current; // Root

    if (type === 'file') {
        return await current.getFileHandle(last, { create: create });
    } else {
        return await current.getDirectoryHandle(last, { create: create });
    }
}

export async function writeFile(path, content) {
    try {
        const fileHandle = await resolveHandle(path, true, 'file');
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        try {
            if (navigator.serviceWorker && navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({
                    type: 'FS_FILE_CHANGED',
                    path
                });
            }
        } catch {
            // Ignore SW notification errors
        }
        return { success: true };
    } catch (err) {
        return { success: false, error: err?.message || 'write failed' };
    }
}

export async function readFile(path, asText = false) {
    try {
        const fileHandle = await resolveHandle(path, false, 'file');
        const file = await fileHandle.getFile();
        if (asText) {
            return { success: true, data: await file.text() };
        } else {
            return { success: true, data: await file.arrayBuffer() };
        }
    } catch (err) {
        return { success: false, error: "File not found" };
    }
}

export async function createDir(path) {
    try {
        await resolveHandle(path, true, 'directory');
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function remove(path) {
    try {
        // We need the parent directory and the name to remove it
        const parts = path.split('/').filter(p => p);
        const name = parts.pop();
        const parentPath = parts.join('/');
        
        // Get parent handle (handle root edge case)
        let parentHandle;
        if (parts.length === 0) parentHandle = await getRoot();
        else parentHandle = await resolveHandle(parentPath, false, 'directory');

        await parentHandle.removeEntry(name, { recursive: true });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function listFiles(path = '/') {
    try {
        let dirHandle;
        if (path === '/') dirHandle = await getRoot();
        else dirHandle = await resolveHandle(path, false, 'directory');

        const entries = [];
        for await (const [name, handle] of dirHandle.entries()) {
            entries.push({
                name,
                type: handle.kind // 'file' or 'directory'
            });
        }
        // Sort: Directories first, then files
        entries.sort((a, b) => {
            if (a.type === b.type) return a.name.localeCompare(b.name);
            return a.type === 'directory' ? -1 : 1;
        });
        
        return { success: true, data: entries };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function stat(path) {
    try {
        if (!path || path === '/') {
            return { success: true, data: { exists: true, isDir: true } };
        }
        try {
            await resolveHandle(path, false, 'directory');
            return { success: true, data: { exists: true, isDir: true } };
        } catch {
            // ignore, try file
        }
        await resolveHandle(path, false, 'file');
        return { success: true, data: { exists: true, isDir: false } };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// Helper for Kernel Sync: Get full tree as flat list of {path, content}
// This is expensive but necessary for the Worker sync currently
export async function getFullTree(dirHandle = null, currentPath = '') {
    const root = dirHandle || await getRoot();
    let results = [];

    for await (const [name, handle] of root.entries()) {
        const fullPath = `${currentPath}/${name}`;
        if (handle.kind === 'file') {
            results.push({ path: fullPath, kind: 'file', handle });
        } else {
            results.push({ path: fullPath, kind: 'directory' });
            const sub = await getFullTree(handle, fullPath);
            results = results.concat(sub);
        }
    }
    return results;
}
