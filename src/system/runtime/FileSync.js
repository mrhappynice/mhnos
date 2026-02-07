/**
 * MHNOS File Sync - OPFS ↔ Runtime Workspace
 * 
 * Provides bidirectional file synchronization between the browser's
 * Origin Private File System (OPFS) and the external runtime workspace.
 */

import * as fs from '../../kernel/fs.js';

export class FileSync {
    constructor(runtime) {
        this.runtime = runtime;
        this.syncInProgress = false;
        this.lastSyncTime = 0;
    }

    /**
     * Scan OPFS and return a flat list of files with their content
     * @param {string} rootPath - Root path to scan
     * @param {Object} options - Options
     * @param {Set} options.exclude - Patterns to exclude
     * @param {number} options.maxFileSize - Max file size in bytes (default 10MB)
     * @returns {Promise<Array>} Array of {path, content, kind, mtime}
     */
    async scanOPFS(rootPath = '/', options = {}) {
        const { 
            exclude = new Set(['node_modules', '.git', 'dist', '.cache']),
            maxFileSize = 10 * 1024 * 1024 // 10MB
        } = options;
        
        const files = [];
        
        async function scan(path) {
            const result = await fs.listFiles(path);
            if (!result.success) return;
            
            for (const entry of result.data) {
                const fullPath = path === '/' 
                    ? `/${entry.name}` 
                    : `${path}/${entry.name}`;
                
                // Skip excluded patterns
                if (exclude.has(entry.name)) continue;
                if (entry.name.startsWith('.')) continue;
                
                if (entry.type === 'directory') {
                    files.push({
                        path: fullPath,
                        kind: 'directory',
                        mtime: entry.lastModified || Date.now()
                    });
                    await scan(fullPath);
                } else {
                    files.push({
                        path: fullPath,
                        kind: 'file',
                        size: entry.size || 0,
                        mtime: entry.lastModified || Date.now()
                    });
                }
            }
        }
        
        await scan(rootPath);
        return files;
    }

    /**
     * Read file content from OPFS
     * @param {string} path - File path
     * @returns {Promise<ArrayBuffer|null>} File content or null
     */
    async readFileContent(path) {
        const result = await fs.readFile(path, false); // binary
        if (result.success) {
            return result.data;
        }
        return null;
    }

    /**
     * Sync files from OPFS to runtime workspace
     * @param {Object} options - Sync options
     * @param {string} options.path - Root path to sync
     * @param {boolean} options.includeContent - Whether to include file content
     * @param {Function} options.onProgress - Progress callback (current, total, file)
     * @returns {Promise<Object>} Sync result
     */
    async pushToRuntime(options = {}) {
        const { 
            path = '/',
            includeContent = true,
            onProgress = null 
        } = options;
        
        if (this.syncInProgress) {
            throw new Error('Sync already in progress');
        }
        
        if (!this.runtime.connected) {
            throw new Error('Runtime not connected');
        }
        
        this.syncInProgress = true;
        
        try {
            // Scan OPFS
            const files = await this.scanOPFS(path);
            const result = {
                total: files.length,
                synced: 0,
                failed: 0,
                errors: []
            };
            
            // If not including content, just send file list
            if (!includeContent) {
                await this.runtime.syncToRuntime(files.map(f => ({
                    path: f.path,
                    kind: f.kind,
                    mtime: f.mtime
                })));
                return result;
            }
            
            // Read content and sync in batches
            const batch = [];
            const batchSize = 5; // Smaller batches
            
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                
                if (onProgress) {
                    onProgress(i + 1, files.length, file.path);
                }
                
                if (file.kind === 'directory') {
                    batch.push({
                        path: file.path,
                        kind: 'directory',
                        mtime: file.mtime
                    });
                } else {
                    // Skip files that are too large (>5MB)
                    if (file.size > 5 * 1024 * 1024) {
                        result.failed++;
                        result.errors.push({ path: file.path, error: 'File too large (>5MB)' });
                        continue;
                    }
                    
                    const content = await this.readFileContent(file.path);
                    if (content !== null) {
                        batch.push({
                            path: file.path,
                            kind: 'file',
                            content: Array.from(new Uint8Array(content)),
                            mtime: file.mtime
                        });
                    } else {
                        result.failed++;
                        result.errors.push({ path: file.path, error: 'Read failed' });
                    }
                }
                
                // Send batch when full or at end
                if (batch.length >= batchSize || i === files.length - 1) {
                    if (batch.length > 0) {
                        try {
                            console.log(`[FileSync] Sending batch of ${batch.length} files...`);
                            await this.runtime.syncToRuntime(batch);
                            result.synced += batch.length;
                        } catch (e) {
                            console.error(`[FileSync] Batch failed:`, e);
                            result.failed += batch.length;
                            for (const item of batch) {
                                result.errors.push({ path: item.path, error: e.message });
                            }
                        }
                        batch.length = 0;
                    }
                }
            }
            
            this.lastSyncTime = Date.now();
            return result;
            
        } finally {
            this.syncInProgress = false;
        }
    }

    /**
     * Sync files from runtime workspace to OPFS
     * @param {Object} options - Sync options
     * @returns {Promise<Object>} Sync result
     */
    async pullFromRuntime(options = {}) {
        const { onProgress = null } = options;
        
        if (this.syncInProgress) {
            throw new Error('Sync already in progress');
        }
        
        if (!this.runtime.connected) {
            throw new Error('Runtime not connected');
        }
        
        this.syncInProgress = true;
        
        try {
            // Request files from runtime
            const response = await this.runtime.syncFromRuntime();
            
            // response.files contains array of {path, kind, content, mtime}
            const files = response.files || [];
            const result = {
                total: files.length,
                synced: 0,
                failed: 0,
                errors: []
            };
            
            // Write files to OPFS
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                
                try {
                    if (file.kind === 'directory') {
                        await fs.createDir(file.path);
                    } else {
                        const content = new Uint8Array(file.content).buffer;
                        await fs.writeFile(file.path, content);
                    }
                    result.synced++;
                } catch (e) {
                    result.failed++;
                    result.errors.push({ path: file.path, error: e.message });
                }
                
                if (onProgress) {
                    onProgress(i + 1, files.length, file.path);
                }
            }
            
            this.lastSyncTime = Date.now();
            return result;
            
        } finally {
            this.syncInProgress = false;
        }
    }

    /**
     * Get sync status
     * @returns {Object} Status object
     */
    getStatus() {
        return {
            inProgress: this.syncInProgress,
            lastSync: this.lastSyncTime,
            runtimeConnected: this.runtime.connected
        };
    }
}

// Singleton instance
let fileSyncInstance = null;

export function getFileSync(runtime) {
    if (!fileSyncInstance) {
        fileSyncInstance = new FileSync(runtime);
    }
    return fileSyncInstance;
}
