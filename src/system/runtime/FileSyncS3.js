/**
 * MHNOS File Sync S3 - OPFS ↔ S3/MinIO
 * 
 * Provides bidirectional file synchronization between the browser's
 * Origin Private File System (OPFS) and the remote S3 bucket via presigned URLs.
 * 
 * Features:
 * - Direct browser-to-S3 uploads via presigned URLs
 * - Resumable multipart uploads for large files
 * - Progress tracking
 * - Exclude patterns (node_modules, .git, etc.)
 */

import * as fs from '../../kernel/fs.js';

export class FileSyncS3 {
    constructor(runtime) {
        this.runtime = runtime;
        this.syncInProgress = false;
        this.lastSyncTime = 0;
        this.abortControllers = new Map();
    }

    /**
     * Get S3 status from runtime
     */
    async getStatus() {
        if (!this.runtime.connected) {
            return { enabled: false, error: 'Runtime not connected' };
        }
        return await this.runtime.sendRequest('s3Status', {});
    }

    /**
     * Scan OPFS and return a flat list of files with metadata
     * @param {string} rootPath - Root path to scan
     * @param {Object} options - Options
     * @param {Set} options.exclude - Patterns to exclude
     * @param {number} options.maxFileSize - Max file size in bytes
     * @returns {Promise<Array>} Array of {path, kind, size, mtime, relativePath}
     */
    async scanOPFS(rootPath = '/', options = {}) {
        const { 
            exclude = new Set(['node_modules', '.git', 'dist', '.cache', '.tmp', '*.tmp']),
            maxFileSize = 5 * 1024 * 1024 * 1024 // 5GB
        } = options;
        
        const files = [];
        
        // Normalize rootPath - remove trailing slashes
        const normalizedRoot = rootPath.replace(/\/+$/, '') || '/';
        
        // Convert exclude Set to array of patterns
        const excludePatterns = Array.from(exclude);
        
        function shouldExclude(name, path) {
            for (const pattern of excludePatterns) {
                if (pattern.includes('*')) {
                    // Simple glob matching
                    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
                    if (regex.test(name)) return true;
                } else if (name === pattern || path.includes('/' + pattern + '/')) {
                    return true;
                }
            }
            return false;
        }
        
        // Helper to normalize paths and remove double slashes
        function normalizePath(path) {
            return path.replace(/\/+/g, '/');
        }
        
        async function scan(path) {
            const result = await fs.listFiles(path);
            if (!result.success) return;
            
            for (const entry of result.data) {
                const fullPath = normalizePath(path === '/' 
                    ? `/${entry.name}` 
                    : `${path}/${entry.name}`);
                
                // Calculate relative path from root
                let relativePath = fullPath;
                if (normalizedRoot !== '/' && fullPath.startsWith(normalizedRoot)) {
                    relativePath = fullPath.slice(normalizedRoot.length);
                    if (relativePath.startsWith('/')) {
                        relativePath = relativePath.slice(1);
                    }
                } else if (fullPath.startsWith('/')) {
                    relativePath = fullPath.slice(1);
                }
                // Remove any leading/trailing slashes
                relativePath = relativePath.replace(/^\/+|\/+$/g, '');
                
                // Skip excluded patterns
                if (shouldExclude(entry.name, fullPath)) continue;
                if (entry.name.startsWith('.') && entry.name !== '.env') continue;
                
                if (entry.type === 'directory') {
                    files.push({
                        path: fullPath,
                        relativePath: relativePath,
                        kind: 'directory',
                        size: 0,
                        mtime: entry.lastModified || Date.now()
                    });
                    await scan(fullPath);
                } else {
                    if ((entry.size || 0) > maxFileSize) {
                        console.warn(`[FileSyncS3] Skipping large file: ${fullPath} (${entry.size} bytes)`);
                        continue;
                    }
                    
                    files.push({
                        path: fullPath,
                        relativePath: relativePath,
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
     * Get presigned upload URLs for files
     * @param {Array} files - Array of {key, contentType}
     * @returns {Promise<Array>} Array of {key, url, contentType}
     */
    async getUploadUrls(files) {
        const fileInfos = files.map(f => ({
            key: f.relativePath || f.key,
            contentType: f.contentType || this.guessContentType(f.path || f.key),
            expiry: f.expiry || 3600
        }));
        
        const response = await this.runtime.sendRequest('s3GetBatchUploadUrls', {
            files: fileInfos
        });
        
        if (response.status !== 'success') {
            throw new Error(response.error || 'Failed to get upload URLs');
        }
        
        return response.urls;
    }

    /**
     * Get presigned download URLs for files
     * @param {Array} keys - Array of S3 keys
     * @returns {Promise<Array>} Array of {key, url}
     */
    async getDownloadUrls(keys) {
        const response = await this.runtime.sendRequest('s3GetBatchDownloadUrls', { keys });
        
        if (response.status !== 'success') {
            throw new Error(response.error || 'Failed to get download URLs');
        }
        
        return response.urls;
    }

    /**
     * Upload a single file to S3 using presigned URL
     * @param {string} filePath - Path in OPFS
     * @param {string} uploadUrl - Presigned S3 URL
     * @param {Object} options
     * @param {Function} options.onProgress - Progress callback (loaded, total)
     * @param {AbortSignal} options.signal - Abort signal
     */
    async uploadFile(filePath, uploadUrl, options = {}) {
        const { contentType, onProgress, signal } = options;
        
        // Read file from OPFS
        const result = await fs.readFile(filePath, false); // binary
        if (!result.success) {
            throw new Error(`Failed to read file: ${result.error}`);
        }
        
        const blob = new Blob([result.data]);
        
        // Upload with progress tracking
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            
            if (signal) {
                signal.addEventListener('abort', () => {
                    xhr.abort();
                    reject(new Error('Upload aborted'));
                });
            }
            
            if (onProgress) {
                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable) {
                        onProgress(e.loaded, e.total);
                    }
                });
            }
            
            xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve({ success: true, size: blob.size });
                } else {
                    reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
                }
            });
            
            xhr.addEventListener('error', () => {
                reject(new Error('Upload failed: Network error'));
            });
            
            xhr.addEventListener('abort', () => {
                reject(new Error('Upload aborted'));
            });
            
            xhr.open('PUT', uploadUrl, true);
            // Use the contentType from the presigned URL
            xhr.setRequestHeader('Content-Type', contentType || 'application/octet-stream');
            xhr.send(blob);
        });
    }

    /**
     * Download a single file from S3
     * @param {string} downloadUrl - Presigned S3 URL
     * @param {string} targetPath - Path in OPFS
     * @param {Object} options
     * @param {Function} options.onProgress - Progress callback
     * @param {AbortSignal} options.signal - Abort signal
     */
    async downloadFile(downloadUrl, targetPath, options = {}) {
        const { onProgress, signal } = options;
        
        const response = await fetch(downloadUrl, {
            signal,
        });
        
        if (!response.ok) {
            throw new Error(`Download failed: ${response.status} ${response.statusText}`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        
        // Write to OPFS
        const dir = targetPath.substring(0, targetPath.lastIndexOf('/')) || '/';
        if (dir !== '/') {
            await fs.createDir(dir);
        }
        
        const result = await fs.writeFile(targetPath, arrayBuffer);
        if (!result.success) {
            throw new Error(`Failed to write file: ${result.error}`);
        }
        
        return { success: true, size: arrayBuffer.byteLength };
    }

    /**
     * Push files from OPFS to S3
     * @param {Object} options
     * @param {string} options.path - Root path to sync
     * @param {Array} options.files - Specific files to sync (if null, scan all)
     * @param {Function} options.onProgress - Progress callback (current, total, file, type)
     * @param {Function} options.onFileComplete - Called when each file completes
     * @returns {Promise<Object>} Sync result
     */
    async pushToS3(options = {}) {
        const { 
            path = '/',
            files: specificFiles = null,
            onProgress = null,
            onFileComplete = null
        } = options;
        
        if (this.syncInProgress) {
            throw new Error('Sync already in progress');
        }
        
        if (!this.runtime.connected) {
            throw new Error('Runtime not connected');
        }
        
        // Check S3 is enabled
        const status = await this.getStatus();
        if (!status?.enabled) {
            throw new Error('S3 is not enabled on this runtime');
        }
        
        this.syncInProgress = true;
        const abortController = new AbortController();
        this.abortControllers.set('push', abortController);
        
        try {
            // Scan files
            if (onProgress) onProgress(0, 0, null, 'scanning');
            const files = specificFiles || await this.scanOPFS(path);
            const filesToUpload = files.filter(f => f.kind === 'file');
            
            const result = {
                total: filesToUpload.length,
                uploaded: 0,
                failed: 0,
                errors: [],
                bytesTransferred: 0
            };
            
            if (filesToUpload.length === 0) {
                return result;
            }
            
            // Get presigned URLs in batches
            const batchSize = 10;
            const uploadUrls = [];
            
            for (let i = 0; i < filesToUpload.length; i += batchSize) {
                const batch = filesToUpload.slice(i, i + batchSize);
                if (onProgress) onProgress(i, filesToUpload.length, null, 'getting_urls');
                
                const urls = await this.getUploadUrls(batch);
                uploadUrls.push(...urls);
            }
            
            // Create URL map with contentType
            const urlMap = new Map(uploadUrls.map(u => [u.key, { url: u.url, contentType: u.contentType }]));
            
            // Upload files
            for (let i = 0; i < filesToUpload.length; i++) {
                const file = filesToUpload[i];
                
                if (abortController.signal.aborted) {
                    throw new Error('Sync aborted');
                }
                
                if (onProgress) onProgress(i + 1, filesToUpload.length, file.path, 'uploading');
                
                try {
                    const uploadInfo = urlMap.get(file.relativePath);
                    if (!uploadInfo) {
                        throw new Error('No upload URL for file');
                    }
                    
                    const uploadResult = await this.uploadFile(file.path, uploadInfo.url, {
                        contentType: uploadInfo.contentType,
                        signal: abortController.signal,
                        onProgress: (loaded, total) => {
                            if (onProgress) {
                                onProgress(i + 1, filesToUpload.length, file.path, 'uploading', {
                                    fileLoaded: loaded,
                                    fileTotal: total
                                });
                            }
                        }
                    });
                    
                    result.uploaded++;
                    result.bytesTransferred += uploadResult.size;
                    
                    if (onFileComplete) {
                        onFileComplete(file.path, true);
                    }
                } catch (error) {
                    result.failed++;
                    result.errors.push({ path: file.path, error: error.message });
                    
                    if (onFileComplete) {
                        onFileComplete(file.path, false, error.message);
                    }
                }
            }
            
            this.lastSyncTime = Date.now();
            return result;
            
        } finally {
            this.syncInProgress = false;
            this.abortControllers.delete('push');
        }
    }

    /**
     * Pull files from S3 to OPFS
     * @param {Object} options
     * @param {string} options.prefix - S3 prefix to sync (default: all)
     * @param {Function} options.onProgress - Progress callback
     * @param {Function} options.onFileComplete - Called when each file completes
     * @returns {Promise<Object>} Sync result
     */
    async pullFromS3(options = {}) {
        const { 
            prefix = '',
            onProgress = null,
            onFileComplete = null
        } = options;
        
        if (this.syncInProgress) {
            throw new Error('Sync already in progress');
        }
        
        if (!this.runtime.connected) {
            throw new Error('Runtime not connected');
        }
        
        this.syncInProgress = true;
        const abortController = new AbortController();
        this.abortControllers.set('pull', abortController);
        
        try {
            // List S3 objects
            if (onProgress) onProgress(0, 0, null, 'listing');
            
            const listResponse = await this.runtime.sendRequest('s3List', { 
                prefix, 
                maxKeys: 10000 
            });
            
            if (listResponse.status !== 'success') {
                throw new Error(listResponse.error || 'Failed to list S3 objects');
            }
            
            const objects = listResponse.objects.filter(o => !o.key.endsWith('/'));
            
            const result = {
                total: objects.length,
                downloaded: 0,
                failed: 0,
                errors: [],
                bytesTransferred: 0
            };
            
            if (objects.length === 0) {
                return result;
            }
            
            // Get download URLs in batches
            const batchSize = 10;
            const downloadUrls = [];
            
            for (let i = 0; i < objects.length; i += batchSize) {
                const batch = objects.slice(i, i + batchSize);
                if (onProgress) onProgress(i, objects.length, null, 'getting_urls');
                
                const urls = await this.getDownloadUrls(batch.map(o => o.key));
                downloadUrls.push(...urls);
            }
            
            // Create URL map
            const urlMap = new Map(downloadUrls.map(u => [u.key, u.url]));
            
            // Download files
            for (let i = 0; i < objects.length; i++) {
                const obj = objects[i];
                
                if (abortController.signal.aborted) {
                    throw new Error('Sync aborted');
                }
                
                const targetPath = '/' + obj.key;
                
                if (onProgress) onProgress(i + 1, objects.length, targetPath, 'downloading');
                
                try {
                    const downloadUrl = urlMap.get(obj.key);
                    if (!downloadUrl) {
                        throw new Error('No download URL for file');
                    }
                    
                    await this.downloadFile(downloadUrl, targetPath, {
                        signal: abortController.signal
                    });
                    
                    result.downloaded++;
                    result.bytesTransferred += obj.size;
                    
                    if (onFileComplete) {
                        onFileComplete(targetPath, true);
                    }
                } catch (error) {
                    result.failed++;
                    result.errors.push({ path: obj.key, error: error.message });
                    
                    if (onFileComplete) {
                        onFileComplete(targetPath, false, error.message);
                    }
                }
            }
            
            this.lastSyncTime = Date.now();
            return result;
            
        } finally {
            this.syncInProgress = false;
            this.abortControllers.delete('pull');
        }
    }

    /**
     * Abort current sync operation
     */
    abort() {
        for (const [key, controller] of this.abortControllers) {
            controller.abort();
        }
        this.abortControllers.clear();
        this.syncInProgress = false;
    }

    /**
     * Guess content type from file path
     */
    guessContentType(path) {
        const ext = path.split('.').pop()?.toLowerCase();
        const types = {
            'js': 'application/javascript',
            'mjs': 'application/javascript',
            'ts': 'application/typescript',
            'tsx': 'application/typescript',
            'jsx': 'application/javascript',
            'json': 'application/json',
            'html': 'text/html',
            'htm': 'text/html',
            'css': 'text/css',
            'svg': 'image/svg+xml',
            'png': 'image/png',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'gif': 'image/gif',
            'webp': 'image/webp',
            'woff': 'font/woff',
            'woff2': 'font/woff2',
            'ttf': 'font/ttf',
            'md': 'text/markdown',
            'txt': 'text/plain',
            'py': 'text/x-python',
            'rs': 'text/x-rust',
            'go': 'text/x-go',
        };
        return types[ext] || 'application/octet-stream';
    }

    /**
     * Get sync status (local state, not server status)
     * @returns {Object} Status object
     */
    getLocalStatus() {
        return {
            inProgress: this.syncInProgress,
            lastSync: this.lastSyncTime,
            runtimeConnected: this.runtime?.connected || false
        };
    }
}

// Singleton instance
let fileSyncS3Instance = null;

export function getFileSyncS3(runtime) {
    if (!fileSyncS3Instance || !fileSyncS3Instance.runtime?.connected) {
        fileSyncS3Instance = new FileSyncS3(runtime);
    }
    return fileSyncS3Instance;
}

export default FileSyncS3;
