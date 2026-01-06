// src/system/boot.js
import * as fs from '../kernel/fs.js';

export async function installStaticFiles(shell) {
    shell.print('[BOOT] Checking for static files...', 'system');

    try {
        // 1. Fetch the manifest
        const res = await fetch('./manifest.json');
        if (!res.ok) throw new Error("No manifest.json found");
        
        const files = await res.json();

        // 2. Iterate and download
        for (const file of files) {
            // Create directory if needed
            const dir = file.dest.substring(0, file.dest.lastIndexOf('/'));
            if (dir) await fs.createDir(dir);

            // Fetch the raw content from the server
            const fileRes = await fetch(file.src);
            if (fileRes.ok) {
                const buffer = await fileRes.arrayBuffer();
                await fs.writeFile(file.dest, buffer);
                // shell.print(`[BOOT] Installed ${file.dest}`, 'system'); // Optional: noisy
            } else {
                shell.print(`[BOOT] Failed to fetch ${file.src}`, 'error');
            }
        }
        shell.print('[BOOT] Static files synced ', 'success');
    } catch (e) {
        shell.print(`[BOOT] Static sync skipped: ${e.message}`, 'system');
    }
}
