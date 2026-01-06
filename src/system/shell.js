import * as fs from '../kernel/fs.js';
import { Nano, SettingsApp, FileExplorer, BrowserApp, LauncherApp } from './apps.js';
import { PackageManager } from './npm.js';

export class Shell {
    constructor(os) {
        this.os = os;
        this.input = document.getElementById('cmd-input');
        this.output = document.getElementById('shell-output');
        this.promptStr = document.querySelector('.prompt');
        
        // --- RESTORED MISSING PROPERTIES ---
        this.history = [];
        this.historyIndex = -1;
        // -----------------------------------
        
        this.cwd = '/';
        
        // Initialize Package Manager
        this.npm = new PackageManager(this);

        this.commands = {
            'help': () => this.print("Commands: ls, cd, mkdir, rm, pwd, npm, edit, md, run, gitclone, browser, files, launcher, ps, kill, clear"),
            'clear': () => this.output.innerHTML = '',
            'cls': () => this.output.innerHTML = '',
            
            // --- DIRECTORY COMMANDS ---
            'pwd': () => this.print(this.cwd),

            'ls': async (args) => {
                const target = args[0] ? this.resolvePath(args[0]) : this.cwd;
                const res = await fs.listFiles(target);
                if (res.success) {
                    if (res.data.length === 0) return this.print("(empty)", 'system');
                    res.data.forEach(item => {
                        if(item.type === 'directory') this.print(`DIR  ${item.name}/`, 'accent');
                        else this.print(`FILE ${item.name}`);
                    });
                } else {
                    this.print(`Error: ${res.error}`, 'error');
                }
            },

            'cd': async (args) => {
                if (!args[0]) { this.cwd = '/'; this.updatePrompt(); return; }
                const target = this.resolvePath(args[0]);
                const res = await fs.listFiles(target);
                if (res.success) {
                    this.cwd = target;
                    this.updatePrompt();
                } else {
                    this.print(`cd: ${args[0]}: No such directory`, 'error');
                }
            },

            'mkdir': async (args) => {
                if (!args[0]) return this.print("Usage: mkdir <name>", 'error');
                const path = this.resolvePath(args[0]);
                const res = await fs.createDir(path);
                if(res.success) this.print(`Created ${path}`, 'success');
                else this.print(res.error, 'error');
            },

            'rm': async (args) => {
                if (!args[0]) return this.print("Usage: rm <path>", 'error');
                const path = this.resolvePath(args[0]);
                if (path === '/') return this.print("Cannot remove root", 'error');
                const res = await fs.remove(path);
                if(res.success) this.print(`Removed ${path}`, 'success');
                else this.print(res.error, 'error');
            },

            // --- FILE UTILS ---
            'cat': async (args) => {
                if(!args[0]) return this.print("Usage: cat <filename>", 'error');
                const path = this.resolvePath(args[0]);
                const res = await fs.readFile(path, true);
                if(res.success) this.print(res.data);
                else this.print("File not found.", 'error');
            },

            'edit': (args) => {
                const editor = new Nano(this.os);
                if(args[0]) {
                    const path = this.resolvePath(args[0]);
                    this.openFileInIDE(path, editor);
                }
                else editor.open();
            },
            'md': (args) => {
                if(!args[0]) return this.print("Usage: md <file>", 'error');
                const editor = new Nano(this.os);
                const path = this.resolvePath(args[0]);
                this.openFileInIDE(path, editor, { preview: true });
            },

            // --- PROCESSES ---
            'run': async (args) => {
                if(!args[0]) return this.print("Usage: run <file>", 'error');
                const path = this.resolvePath(args[0]);
                const res = await fs.readFile(path, true);
                if(res.success) {
                    const pid = await this.os.spawn(res.data, path);
                    this.print(`[Process ${pid}] Started: ${path}`, 'system');
                }
                else this.print("File not found.", 'error');
            },

            // --- NPM COMMAND (Delegates to PackageManager) ---
            'npm': async (args) => {
                const [action, pkg] = args;
                if (action === 'install' && pkg) {
                    await this.npm.install(pkg);
                } else {
                    this.print("Usage: npm install <package>", 'error');
                }
            },
            
            'wget': async (args) => {
    const url = args[0];
    if (!url) return this.print("Usage: wget <url> [filename]", 'error');

    // Determine filename (use 2nd arg, or derive from URL, or default)
    let filename = args[1];
    if (!filename) {
        const parts = url.split('/');
        filename = parts[parts.length - 1] || 'downloaded_file';
    }

    // Resolve path relative to CWD
    const fullPath = this.resolvePath(filename);

    this.print(`Downloading ${url}...`, 'system');
    
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const buffer = await res.arrayBuffer();
        const result = await fs.writeFile(fullPath, buffer);
        
        if (result.success) {
            this.print(`Saved to ${fullPath} (${buffer.byteLength} bytes)`, 'success');
        } else {
            throw new Error(result.error);
        }
    } catch (e) {
        this.print(`Download failed: ${e.message}`, 'error');
        this.print(`Note: Cross-Origin (CORS) blocked requests will fail.`, 'system');
    }
},
            'gitclone': async (args) => {
                const url = args[0];
                const dest = args[1];
                if (!url) return this.print("Usage: gitclone <git-url> [dest]", 'error');
                await this.downloadGitHubRepo(url, dest);
            },

            // --- APPS ---
            'files': () => new FileExplorer(this.os).open(this.cwd),
            'browser': () => new BrowserApp(this.os).open(),
            'launcher': () => {
                if (this.os.launcher) this.os.launcher.open();
                else new LauncherApp(this.os).open();
            },
            
            // --- SYSTEM ---
            'ps': () => {
                this.print("PID  |  NAME           |  PORTS", 'system');
                this.print("-----|-----------------|-------", 'system');
                if (this.os.procs.size === 0) this.print("No active processes.", 'system');
                else {
                    this.os.procs.forEach((proc, pid) => {
                        const ports = Array.from(proc.ports).join(', ') || '-';
                        this.print(`${pid.toString().padEnd(4)} | ${proc.name.padEnd(15)} | ${ports}`);
                    });
                }
            },
            
            'kill': (args) => {
                const pid = parseInt(args[0]);
                if (!pid) return this.print("Usage: kill <pid>", 'error');
                if (this.os.procs.has(pid)) this.os.kill(pid);
                else this.print(`PID ${pid} not found.`, 'error');
            }
        };

        this.attachListeners();
        this.attachDragAndDrop();
        this.updatePrompt();
    }

    resolvePath(inputPath) {
        if (!inputPath) return this.cwd;
        
        if (inputPath.startsWith('/')) return inputPath;

        const parts = this.cwd.split('/').filter(p => p);
        const inputParts = inputPath.split('/');

        for (const part of inputParts) {
            if (part === '.') continue;
            if (part === '..') parts.pop();
            else parts.push(part);
        }

        const res = '/' + parts.join('/');
        return res === '//' ? '/' : res;
    }

    updatePrompt() {
        if(this.promptStr) this.promptStr.textContent = `user@mhnos:${this.cwd}$`;
    }

    attachListeners() {
        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'c' && e.ctrlKey) {
                e.preventDefault();
                if (this.os.procs.size > 0) {
                    const lastPid = [...this.os.procs.keys()].pop();
                    this.os.kill(lastPid);
                }
                this.input.value = '';
                return;
            }
            if (e.key === 'Enter') {
                const val = this.input.value.trim();
                if (val) {
                    this.history.push(val);
                    this.historyIndex = this.history.length;
                    this.print(`user@mhnos:${this.cwd}$ ${val}`, 'system');
                    this.execute(val);
                    this.input.value = '';
                }
            }
            if (e.key === 'ArrowUp') {
                if (this.historyIndex > 0) {
                    this.historyIndex--;
                    this.input.value = this.history[this.historyIndex];
                }
            }
        });
        
        document.addEventListener('click', (e) => {
            const tag = e.target.tagName;
            if (tag !== 'TEXTAREA' && tag !== 'INPUT' && tag !== 'BUTTON') {
                this.input.focus();
            }
        });
        
        setTimeout(() => this.input.focus(), 100);
    }
    
    async execute(raw) {
        const [cmd, ...args] = raw.split(' ');
        if (this.commands[cmd]) {
            try {
                await this.commands[cmd](args);
            } catch (err) {
                this.print(`Error: ${err.message}`, 'error');
            }
        } else {
            this.print(`Command not found: ${cmd}`, 'error');
        }
    }

    print(msg, type = '') {
        const line = document.createElement('div');
        line.className = `log-line ${type}`;
        line.textContent = msg;
        this.output.appendChild(line);
        this.output.scrollTop = this.output.scrollHeight;
    }

    async openFileInIDE(path, ideInstance, options = {}) {
        const res = await fs.readFile(path, true);
        if(res.success) ideInstance.open(path, res.data, options);
        else ideInstance.open(path, '', options);
    }

    parseGitHubRepoUrl(rawUrl) {
        const input = rawUrl.trim();
        const sshMatch = input.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
        if (sshMatch) {
            return { owner: sshMatch[1], repo: sshMatch[2], ref: null };
        }

        try {
            const parsed = new URL(input);
            if (parsed.hostname !== 'github.com') return null;
            const parts = parsed.pathname.split('/').filter(Boolean);
            if (parts.length < 2) return null;
            const owner = parts[0];
            const repo = parts[1].replace(/\.git$/, '');
            let ref = null;
            if (parts[2] === 'tree' && parts[3]) ref = parts[3];
            return { owner, repo, ref };
        } catch (e) {
            return null;
        }
    }

    async downloadGitHubRepo(rawUrl, destArg) {
        const info = this.parseGitHubRepoUrl(rawUrl);
        if (!info) {
            this.print("gitclone: Only GitHub URLs are supported.", 'error');
            return;
        }

        const { owner, repo } = info;
        let branch = info.ref;
        const targetDir = this.resolvePath(destArg || repo);

        this.print(`[gitclone] Fetching ${owner}/${repo}...`, 'system');

        if (!branch) {
            const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
            if (!repoRes.ok) {
                this.print(`[gitclone] Repo not found (HTTP ${repoRes.status}).`, 'error');
                return;
            }
            const repoData = await repoRes.json();
            branch = repoData.default_branch || 'main';
        }

        const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
        if (!treeRes.ok) {
            this.print(`[gitclone] Unable to fetch repo tree (HTTP ${treeRes.status}).`, 'error');
            return;
        }
        const treeData = await treeRes.json();
        if (!Array.isArray(treeData.tree)) {
            this.print(`[gitclone] Invalid tree data.`, 'error');
            return;
        }

        if (treeData.truncated) {
            this.print(`[gitclone] Warning: tree truncated by GitHub API.`, 'error');
        }

        await fs.createDir(targetDir);

        const blobs = treeData.tree.filter(entry => entry.type === 'blob');
        this.print(`[gitclone] Downloading ${blobs.length} file(s) from ${branch}...`, 'system');

        let saved = 0;
        let failed = 0;
        const encodedBranch = branch.split('/').map(encodeURIComponent).join('/');

        for (const entry of treeData.tree) {
            if (entry.type === 'tree') {
                await fs.createDir(`${targetDir}/${entry.path}`);
                continue;
            }
            if (entry.type !== 'blob') continue;

            const encodedPath = entry.path.split('/').map(encodeURIComponent).join('/');
            const fileUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodedBranch}/${encodedPath}`;
            try {
                const fileRes = await fetch(fileUrl);
                if (!fileRes.ok) {
                    failed += 1;
                    continue;
                }
                const buffer = await fileRes.arrayBuffer();
                const writeRes = await fs.writeFile(`${targetDir}/${entry.path}`, buffer);
                if (writeRes.success) saved += 1;
                else failed += 1;
            } catch (e) {
                failed += 1;
            }
        }

        const resultMsg = `[gitclone] Saved ${saved} file(s) to ${targetDir}` +
            (failed ? `, ${failed} failed.` : '.');
        this.print(resultMsg, failed ? 'error' : 'success');
    }
    
attachDragAndDrop() {
        const dropZone = document.body;

        // Prevent default browser behavior
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
            }, false);
        });

        // Visual feedback
        dropZone.addEventListener('dragover', () => dropZone.style.boxShadow = 'inset 0 0 20px #0078d7');
        dropZone.addEventListener('dragleave', () => dropZone.style.boxShadow = 'none');
        dropZone.addEventListener('drop', () => dropZone.style.boxShadow = 'none');

        // --- HELPERS ---
        const writeDroppedFile = async (file, basePath) => {
            try {
                // arrayBuffer() is reliable on File objects from getAsFile()
                const buffer = await file.arrayBuffer();
                const savePath = `${basePath}/${file.name}`;
                const res = await fs.writeFile(savePath, buffer);
                if (res.success) {
                    this.print(`[Upload] Saved: ${savePath}`, 'success');
                } else {
                    this.print(`[Upload] Error saving ${file.name}: ${res.error}`, 'error');
                }
            } catch (e) {
                this.print(`[Upload] Failed to read ${file.name}: ${e.message}`, 'error');
            }
        };

        const walkWebkitEntry = async (entry, basePath) => {
            if (entry.isFile) {
                // Only use this path if absolutely necessary (nested files in folders)
                return new Promise((resolve) => {
                    entry.file(async (file) => {
                        await writeDroppedFile(file, basePath);
                        resolve();
                    }, (err) => {
                        console.warn(`[Upload] Entry access failed: ${entry.name}`, err);
                        resolve();
                    });
                });
            }
            if (entry.isDirectory) {
                const dirPath = `${basePath}/${entry.name}`;
                await fs.createDir(dirPath);
                
                const reader = entry.createReader();
                const readEntries = async () => {
                    const entries = await new Promise((resolve) => {
                        reader.readEntries(resolve, (err) => { console.warn(err); resolve([]); });
                    });
                    if (!entries || entries.length === 0) return;
                    for (const child of entries) await walkWebkitEntry(child, dirPath);
                    await readEntries(); // Continue reading until empty
                };
                await readEntries();
            }
        };

        // --- HANDLER ---
        dropZone.addEventListener('drop', async (e) => {
            const items = e.dataTransfer.items;
            const basePath = this.cwd === '/' ? '' : this.cwd;
            const queue = [];

            // 1. COLLECT PHASE (Synchronous)
            // Grab File objects immediately to prevent "NotFoundError" / Stale handles
            if (items && items.length > 0) {
                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    if (item.kind !== 'file') continue;

                    let entry = null;
                    if (item.webkitGetAsEntry) {
                        entry = item.webkitGetAsEntry();
                    }

                    // CRITICAL FIX:
                    // If it is a FILE, use getAsFile() immediately. This gives a persistent Blob.
                    // Only use Entry API if it is a DIRECTORY.
                    if (entry && entry.isFile) {
                        const file = item.getAsFile();
                        if (file) {
                            queue.push({ type: 'file', data: file });
                        }
                    } 
                    else if (entry && entry.isDirectory) {
                        queue.push({ type: 'entry', data: entry });
                    }
                    else {
                        // Fallback
                        const file = item.getAsFile();
                        if (file) queue.push({ type: 'file', data: file });
                    }
                }
            } else {
                // Fallback for browsers not supporting DataTransferItems
                const files = e.dataTransfer.files;
                if (files) {
                    for (let i = 0; i < files.length; i++) {
                        queue.push({ type: 'file', data: files[i] });
                    }
                }
            }

            if (queue.length === 0) return;

            this.print(`[Upload] Processing ${queue.length} item(s)...`, 'system');

            // 2. PROCESS PHASE (Async)
            for (const item of queue) {
                if (item.type === 'entry') {
                    await walkWebkitEntry(item.data, basePath);
                } else {
                    await writeDroppedFile(item.data, basePath);
                }
            }
            
            this.print(`[Upload] Complete.`, 'system');
        });
    }
}