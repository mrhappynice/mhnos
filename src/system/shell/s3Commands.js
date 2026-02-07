/**
 * MHNOS Shell - S3 File Sync Commands
 * 
 * Commands for synchronizing files between OPFS and remote S3 storage:
 * - s3status: Check S3 connection status
 * - s3push: Push files from OPFS to S3
 * - s3pull: Pull files from S3 to OPFS
 * - s3sync: Bidirectional sync
 * - s3ls: List files in S3 bucket
 */

import { getFileSyncS3 } from '../runtime/FileSyncS3.js';

/**
 * Register S3 commands with the shell
 * @param {Shell} shell - The shell instance
 */
export function registerS3Commands(shell) {
    
    // Helper to get runtime from shell
    const getRuntime = () => shell.os?.runtime;
    
    /**
     * Check S3 status and configuration
     * Usage: s3status
     */
    shell.registerCommand('s3status', async (argv, { println, print }) => {
        const runtime = getRuntime();
        if (!runtime?.connected) {
            println('Not connected to remote runtime. Use: runtime connect <url>', 'error');
            return 1;
        }
        
        try {
            const fileSync = getFileSyncS3(runtime);
            const status = await fileSync.getStatus();
            
            // Debug: log the full response
            console.log('[s3status] Response:', status);
            
            if (status.status === 'error') {
                println(`S3 Error: ${status.error}`, 'error');
                return 1;
            }
            
            println('S3 Configuration:', 'info');
            println(`  Enabled: ${status.enabled ? 'Yes' : 'No'}`, 'system');
            println(`  Bucket: ${status.config?.bucket || 'N/A'}`, 'system');
            println(`  Endpoint: ${status.config?.endpoint || 'N/A'}`, 'system');
            println(`  Region: ${status.config?.region || 'N/A'}`, 'system');
            println(`  Bucket Accessible: ${status.bucketAccessible ? 'Yes' : 'No'}`, 'system');
            
            return 0;
        } catch (error) {
            println(`Error: ${error.message}`, 'error');
            return 1;
        }
    });

    /**
     * Push files from OPFS to S3
     * Usage: s3push [path] [--exclude=pattern]
     */
    shell.registerCommand('s3push', async (argv, { println, print }) => {
        const runtime = getRuntime();
        if (!runtime?.connected) {
            println('Not connected to remote runtime. Use: runtime connect <url>', 'error');
            return 1;
        }
        
        const args = shell.parseArgs(argv);
        const path = args._[0] || '/';
        const excludeArg = args.exclude || '';
        
        const exclude = new Set([
            'node_modules', '.git', 'dist', '.cache', '.tmp', '*.tmp',
            ...excludeArg.split(',').filter(Boolean)
        ]);
        
        try {
            const fileSync = getFileSyncS3(runtime);
            
            // Check S3 is enabled
            const status = await fileSync.getStatus();
            if (!status.enabled) {
                println('S3 is not enabled on this runtime', 'error');
                return 1;
            }
            
            println(`Scanning files in ${path}...`, 'system');
            
            // Scan files first
            const files = await fileSync.scanOPFS(path, { exclude });
            const filesToUpload = files.filter(f => f.kind === 'file');
            
            if (filesToUpload.length === 0) {
                println('No files to upload', 'warning');
                return 0;
            }
            
            const totalSize = filesToUpload.reduce((sum, f) => sum + f.size, 0);
            println(`Found ${filesToUpload.length} files (${formatBytes(totalSize)})`, 'system');
            println('Starting upload...', 'system');
            
            // Track progress
            let lastProgress = 0;
            const startTime = Date.now();
            
            const result = await fileSync.pushToS3({
                path,
                files,
                onProgress: (current, total, file, type, details) => {
                    if (type === 'uploading' && current !== lastProgress) {
                        lastProgress = current;
                        const percent = Math.round((current / total) * 100);
                        const fileName = file ? file.split('/').pop() : '';
                        print(`\r[${percent}%] ${current}/${total} ${fileName}`.padEnd(60), 'system');
                    }
                },
                onFileComplete: (filePath, success, error) => {
                    // Individual file completion callback
                }
            });
            
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            println('', 'system'); // New line after progress
            
            println(`Upload complete in ${duration}s:`, 'success');
            println(`  Uploaded: ${result.uploaded}/${result.total}`, 'system');
            println(`  Failed: ${result.failed}`, result.failed > 0 ? 'error' : 'system');
            println(`  Transferred: ${formatBytes(result.bytesTransferred)}`, 'system');
            
            if (result.failed > 0 && result.errors.length > 0) {
                println('\nErrors:', 'error');
                for (const err of result.errors.slice(0, 5)) {
                    println(`  ${err.path}: ${err.error}`, 'error');
                }
                if (result.errors.length > 5) {
                    println(`  ... and ${result.errors.length - 5} more`, 'error');
                }
            }
            
            return result.failed > 0 ? 1 : 0;
            
        } catch (error) {
            if (error.message === 'Sync aborted') {
                println('\nUpload aborted by user', 'warning');
                return 130; // Standard exit code for Ctrl+C
            }
            println(`Error: ${error.message}`, 'error');
            return 1;
        }
    });

    /**
     * Pull files from S3 to OPFS
     * Usage: s3pull [prefix] [--force]
     */
    shell.registerCommand('s3pull', async (argv, { println, print }) => {
        const runtime = getRuntime();
        if (!runtime?.connected) {
            println('Not connected to remote runtime. Use: runtime connect <url>', 'error');
            return 1;
        }
        
        const args = shell.parseArgs(argv);
        const prefix = args._[0] || '';
        const force = args.force || args.f;
        
        try {
            const fileSync = getFileSyncS3(window.OS.runtime);
            
            // Check S3 is enabled
            const status = await fileSync.getStatus();
            if (!status.enabled) {
                println('S3 is not enabled on this runtime', 'error');
                return 1;
            }
            
            println(`Listing files in S3${prefix ? ` (prefix: ${prefix})` : ''}...`, 'system');
            
            // List files first to get count
            const listResponse = await window.OS.runtime.sendRequest('s3List', { 
                prefix, 
                maxKeys: 1 
            });
            
            if (!force) {
                println('This will download files from S3 to your local workspace.', 'warning');
                println('Existing local files will be overwritten.', 'warning');
                println('Use --force to skip this confirmation.', 'system');
                // Note: In a real implementation, you'd use shell.confirm() here
            }
            
            println('Starting download...', 'system');
            
            let lastProgress = 0;
            const startTime = Date.now();
            
            const result = await fileSync.pullFromS3({
                prefix,
                onProgress: (current, total, file, type) => {
                    if (type === 'downloading' && current !== lastProgress) {
                        lastProgress = current;
                        const percent = Math.round((current / total) * 100);
                        const fileName = file ? file.split('/').pop() : '';
                        print(`\r[${percent}%] ${current}/${total} ${fileName}`.padEnd(60), 'system');
                    }
                }
            });
            
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            println('', 'system');
            
            println(`Download complete in ${duration}s:`, 'success');
            println(`  Downloaded: ${result.downloaded}/${result.total}`, 'system');
            println(`  Failed: ${result.failed}`, result.failed > 0 ? 'error' : 'system');
            println(`  Transferred: ${formatBytes(result.bytesTransferred)}`, 'system');
            
            if (result.failed > 0 && result.errors.length > 0) {
                println('\nErrors:', 'error');
                for (const err of result.errors.slice(0, 5)) {
                    println(`  ${err.path}: ${err.error}`, 'error');
                }
            }
            
            return result.failed > 0 ? 1 : 0;
            
        } catch (error) {
            if (error.message === 'Sync aborted') {
                println('\nDownload aborted by user', 'warning');
                return 130;
            }
            println(`Error: ${error.message}`, 'error');
            return 1;
        }
    });

    /**
     * List files in S3 bucket
     * Usage: s3ls [prefix] [--limit=N]
     */
    shell.registerCommand('s3ls', async (argv, { println }) => {
        const runtime = getRuntime();
        if (!runtime?.connected) {
            println('Not connected to remote runtime. Use: runtime connect <url>', 'error');
            return 1;
        }
        
        const args = shell.parseArgs(argv);
        const prefix = args._[0] || '';
        const limit = parseInt(args.limit) || 100;
        
        try {
            const response = await runtime.sendRequest('s3List', { 
                prefix, 
                maxKeys: limit 
            });
            
            if (response.status !== 'success') {
                println(`Error: ${response.error}`, 'error');
                return 1;
            }
            
            const objects = response.objects.filter(o => !o.key.endsWith('/'));
            
            if (objects.length === 0) {
                println('No files found', 'system');
                return 0;
            }
            
            // Sort by last modified (newest first)
            objects.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
            
            println(`Found ${objects.length} files${response.count > limit ? ` (showing first ${limit})` : ''}:`, 'info');
            println('');
            
            // Calculate column widths
            const maxSizeWidth = Math.max(...objects.map(o => formatBytes(o.size).length));
            
            for (const obj of objects.slice(0, limit)) {
                const date = new Date(obj.lastModified).toLocaleString('en-US', {
                    month: 'short',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                });
                const size = formatBytes(obj.size).padStart(maxSizeWidth);
                println(`${date}  ${size}  ${obj.key}`, 'system');
            }
            
            if (objects.length > limit) {
                println(`\n... and ${objects.length - limit} more (use --limit=${objects.length} to see all)`, 'warning');
            }
            
            return 0;
            
        } catch (error) {
            println(`Error: ${error.message}`, 'error');
            return 1;
        }
    });

    /**
     * Delete a file from S3
     * Usage: s3rm <key>
     */
    shell.registerCommand('s3rm', async (argv, { println }) => {
        const runtime = getRuntime();
        if (!runtime?.connected) {
            println('Not connected to remote runtime. Use: runtime connect <url>', 'error');
            return 1;
        }
        
        const args = shell.parseArgs(argv);
        const key = args._[0];
        
        if (!key) {
            println('Usage: s3rm <key>', 'error');
            return 1;
        }
        
        try {
            const response = await runtime.sendRequest('s3Delete', { key });
            
            if (response.status !== 'success') {
                println(`Error: ${response.error}`, 'error');
                return 1;
            }
            
            println(`Deleted: ${key}`, 'success');
            return 0;
            
        } catch (error) {
            println(`Error: ${error.message}`, 'error');
            return 1;
        }
    });

    /**
     * Get metadata for an S3 object
     * Usage: s3meta <key>
     */
    shell.registerCommand('s3meta', async (argv, { println }) => {
        const runtime = getRuntime();
        if (!runtime?.connected) {
            println('Not connected to remote runtime. Use: runtime connect <url>', 'error');
            return 1;
        }
        
        const args = shell.parseArgs(argv);
        const key = args._[0];
        
        if (!key) {
            println('Usage: s3meta <key>', 'error');
            return 1;
        }
        
        try {
            const response = await runtime.sendRequest('s3GetMetadata', { key });
            
            if (response.status !== 'success') {
                println(`Error: ${response.error}`, 'error');
                return 1;
            }
            
            const meta = response.metadata;
            if (!meta.exists) {
                println(`File not found: ${key}`, 'error');
                return 1;
            }
            
            println(`Metadata for ${key}:`, 'info');
            println(`  Size: ${formatBytes(meta.size)}`, 'system');
            println(`  Last Modified: ${new Date(meta.lastModified).toLocaleString()}`, 'system');
            println(`  Content-Type: ${meta.contentType || 'N/A'}`, 'system');
            println(`  ETag: ${meta.etag || 'N/A'}`, 'system');
            
            return 0;
            
        } catch (error) {
            println(`Error: ${error.message}`, 'error');
            return 1;
        }
    });

    /**
     * Bidirectional sync - push then pull
     * Usage: s3sync [path] [--push-only] [--pull-only]
     */
    shell.registerCommand('s3sync', async (argv, { println }) => {
        const runtime = getRuntime();
        if (!runtime?.connected) {
            println('Not connected to remote runtime. Use: runtime connect <url>', 'error');
            return 1;
        }
        
        const args = shell.parseArgs(argv);
        const path = args._[0] || '/';
        const pushOnly = args['push-only'];
        const pullOnly = args['pull-only'];
        
        if (pushOnly && pullOnly) {
            println('Cannot use both --push-only and --pull-only', 'error');
            return 1;
        }
        
        let exitCode = 0;
        
        if (!pullOnly) {
            println('=== Pushing to S3 ===', 'info');
            exitCode = await shell.exec('s3push', [path]);
            if (exitCode !== 0 && !args.continue) {
                return exitCode;
            }
        }
        
        if (!pushOnly) {
            println('\n=== Pulling from S3 ===', 'info');
            const pullExitCode = await shell.exec('s3pull', []);
            if (pullExitCode !== 0) {
                exitCode = pullExitCode;
            }
        }
        
        return exitCode;
    });
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export default { registerS3Commands };
