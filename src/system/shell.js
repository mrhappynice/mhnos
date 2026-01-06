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
            'help': () => this.print("Commands: ls, cd, mkdir, rm, pwd, npm, edit, md, run, browser, files, launcher, ps, kill, clear"),
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
    
    attachDragAndDrop() {
    const dropZone = document.body;

    // Prevent default browser behavior (opening the file)
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, false);
    });

    // Visual feedback (optional)
    dropZone.addEventListener('dragover', () => dropZone.style.boxShadow = 'inset 0 0 20px #0078d7');
    dropZone.addEventListener('dragleave', () => dropZone.style.boxShadow = 'none');
    dropZone.addEventListener('drop', () => dropZone.style.boxShadow = 'none');

    // Handle Drop
    dropZone.addEventListener('drop', async (e) => {
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            this.print(`[Upload] Processing ${files.length} file(s)...`, 'system');
            
            for (const file of files) {
                const reader = new FileReader();
                
                reader.onload = async (evt) => {
                    const buffer = evt.target.result; // ArrayBuffer
                    const savePath = `${this.cwd === '/' ? '' : this.cwd}/${file.name}`;
                    
                    const res = await fs.writeFile(savePath, buffer);
                    if (res.success) {
                        this.print(`[Upload] Saved: ${savePath}`, 'success');
                    } else {
                        this.print(`[Upload] Error saving ${file.name}: ${res.error}`, 'error');
                    }
                };
                
                reader.readAsArrayBuffer(file);
            }
        }
    });
}
}
