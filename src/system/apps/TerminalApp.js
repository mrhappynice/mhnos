let _xtermPromise = null;
async function loadXterm() {
  if (_xtermPromise) return _xtermPromise;
  _xtermPromise = (async () => {
    // Load CSS
    if (!document.getElementById('xterm-css')) {
      const link = document.createElement('link');
      link.id = 'xterm-css';
      link.rel = 'stylesheet';
      link.href = '/vendor/xterm.css';
      document.head.appendChild(link);
      await new Promise(r => setTimeout(r, 50));
    }
    
    // Load xterm modules from local vendor folder
    await import('/vendor/xterm.js');
    await import('/vendor/xterm-addon-fit.js');
    
    const Terminal = window.Terminal;
    // FitAddon might be directly on window or nested
    const FitAddon = window.FitAddon?.FitAddon || window.FitAddon;
    
    if (!Terminal) throw new Error('xterm.js failed to load - Terminal not found on window');
    if (!FitAddon) throw new Error('xterm-addon-fit.js failed to load - FitAddon not found');
    
    return { Terminal, FitAddon };
  })();
  return _xtermPromise;
}

class TerminalEmulator {
    constructor(container, cols = 80, rows = 24) {
        this.cols = cols;
        this.rows = rows;
        this.cursorRow = 0;
        this.cursorCol = 0;
        this.savedCursor = { row: 0, col: 0 };
        this.escMode = false;
        this.escBuffer = '';
        this.buffer = Array.from({ length: rows }, () => Array(cols).fill(' '));
        this.mainBuffer = this.buffer;
        this.altBuffer = Array.from({ length: rows }, () => Array(cols).fill(' '));
        this.inAltScreen = false;

        this.pre = document.createElement('pre');
        this.pre.style.cssText = [
            'margin:0',
            'padding:10px',
            'font-family:"IBM Plex Mono", "Courier New", monospace',
            'font-size:13px',
            'line-height:1.4',
            'color:#e5e5e5',
            'white-space:pre',
            'user-select:text'
        ].join(';');
        container.appendChild(this.pre);
        this.render();
    }

    clearScreen() {
        this.buffer = Array.from({ length: this.rows }, () => Array(this.cols).fill(' '));
        this.cursorRow = 0;
        this.cursorCol = 0;
        if (this.inAltScreen) {
            this.altBuffer = this.buffer;
        } else {
            this.mainBuffer = this.buffer;
        }
    }

    clearLine() {
        this.buffer[this.cursorRow].fill(' ', this.cursorCol);
    }

    scroll() {
        this.buffer.shift();
        this.buffer.push(Array(this.cols).fill(' '));
        this.cursorRow = this.rows - 1;
    }

    moveCursor(row, col) {
        this.cursorRow = Math.max(0, Math.min(this.rows - 1, row));
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, col));
    }

    handleCSI(seq) {
        const finalChar = seq.slice(-1);
        let params = seq.slice(0, -1);
        const isPrivate = params.startsWith('?');
        if (isPrivate) params = params.slice(1);
        params = params.split(';').filter(p => p !== '').map(p => parseInt(p, 10));

        const n = (idx, def) => (params[idx] || params[idx] === 0) ? params[idx] : def;

        if (isPrivate && finalChar === 'h') {
            const mode = n(0, 0);
            if (mode === 1049 || mode === 47 || mode === 1047) {
                this.savedCursor = { row: this.cursorRow, col: this.cursorCol };
                this.inAltScreen = true;
                this.buffer = this.altBuffer;
                this.clearScreen();
                this.render();
            }
            return;
        }

        if (isPrivate && finalChar === 'l') {
            const mode = n(0, 0);
            if (mode === 1049 || mode === 47 || mode === 1047) {
                this.inAltScreen = false;
                this.buffer = this.mainBuffer;
                this.cursorRow = this.savedCursor.row;
                this.cursorCol = this.savedCursor.col;
                this.render();
            }
            return;
        }

        switch (finalChar) {
            case 'A': // cursor up
                this.moveCursor(this.cursorRow - n(0, 1), this.cursorCol);
                break;
            case 'B': // cursor down
                this.moveCursor(this.cursorRow + n(0, 1), this.cursorCol);
                break;
            case 'C': // cursor right
                this.moveCursor(this.cursorRow, this.cursorCol + n(0, 1));
                break;
            case 'D': // cursor left
                this.moveCursor(this.cursorRow, this.cursorCol - n(0, 1));
                break;
            case 'H':
            case 'f': {
                const row = n(0, 1) - 1;
                const col = n(1, 1) - 1;
                this.moveCursor(row, col);
                break;
            }
            case 'J': { // clear screen
                const mode = n(0, 0);
                if (mode === 2 || mode === 3) {
                    this.clearScreen();
                } else if (mode === 0) {
                    for (let r = this.cursorRow; r < this.rows; r++) {
                        const start = (r === this.cursorRow) ? this.cursorCol : 0;
                        this.buffer[r].fill(' ', start);
                    }
                }
                break;
            }
            case 'K': // clear line
                this.clearLine();
                break;
            case 'm': // colors ignored
            default:
                break;
        }
    }

    write(data) {
        const text = String(data);
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (this.escMode) {
                this.escBuffer += ch;
                if (this.escBuffer[0] === '[') {
                    const code = this.escBuffer[this.escBuffer.length - 1];
                    if (code >= '@' && code <= '~') {
                        this.handleCSI(this.escBuffer);
                        this.escBuffer = '';
                        this.escMode = false;
                    }
                } else {
                    if (this.escBuffer === 'c') {
                        this.clearScreen();
                        this.render();
                    }
                    this.escMode = false;
                    this.escBuffer = '';
                }
                continue;
            }

            if (ch === '\x1b') {
                this.escMode = true;
                this.escBuffer = '';
                continue;
            }

            if (ch === '\n') {
                this.cursorRow += 1;
                this.cursorCol = 0;
                if (this.cursorRow >= this.rows) this.scroll();
                continue;
            }
            if (ch === '\r') {
                this.cursorCol = 0;
                continue;
            }
            if (ch === '\b') {
                this.cursorCol = Math.max(0, this.cursorCol - 1);
                continue;
            }

            this.buffer[this.cursorRow][this.cursorCol] = ch;
            this.cursorCol += 1;
            if (this.cursorCol >= this.cols) {
                this.cursorCol = 0;
                this.cursorRow += 1;
                if (this.cursorRow >= this.rows) this.scroll();
            }
        }
        this.render();
    }

    render() {
        const lines = this.buffer.map(row => row.join(''));
        this.pre.textContent = lines.join('\n');
    }
}

export class TerminalApp {
    constructor(os) {
        this.os = os;
        this.win = null;
        this.pid = null;
        this.term = null;

        this.xterm = null;
        this.fit = null;
        this.ro = null;

        // interactive shell state (when pid is null)
        this.shell = null;
        this.prompt = 'user@mhnos:/$ ';
        this.line = '';
        this.cursor = 0;
        this.history = [];
        this.histIdx = 0;
    }

    open(pid, isRuntime = false) {
        this.pid = pid || null;
        this.isRuntime = isRuntime;
        
        const container = document.createElement('div');
        container.style.cssText = [
            'display:flex',
            'flex-direction:column',
            'height:100%',
            'width:100%',
            'min-height:0'
        ].join(';');
        container.tabIndex = 0;

        const output = document.createElement('div');
        output.style.cssText = [
            'flex:1',
            'min-height:0',
            'overflow:hidden',
            'position:relative'
        ].join(';');
        container.appendChild(output);

        const mount = document.createElement('div');
        mount.style.cssText = [
            'position:absolute',
            'inset:0',
            'padding:8px'
        ].join(';');
        output.appendChild(mount);

        this.output = output;
        this.mount = mount;

        container.addEventListener('mousedown', (e) => {
            // Bring window to front via WM
            if (this.win && this.os.wm.focus) {
                this.os.wm.focus(this.win);
            }
            // Focus xterm
            setTimeout(() => {
                container.focus();
                if (this.xterm) this.xterm.focus();
            }, 0);
        });

        this.byteCount = 0;
        
        const titlePrefix = isRuntime ? 'Runtime Terminal' : 'Terminal';
        this.win = this.os.wm.createWindow(
            `${titlePrefix} ${this.pid ? `(${this.pid})` : ''}`,
            container,
            { width: 660, height: 480 }
        );
        this.win.querySelector('.btn-close').addEventListener('click', () => this.detach());

        // open() is sync; attach/init async - wait for DOM to be ready
        setTimeout(() => {
            this._init().catch(err => console.error('Terminal init failed', err));
        }, 100);

        setTimeout(() => {
            container.focus();
            if (this.xterm) this.xterm.focus();
        }, 50);
    }

    async _init() {
        try {
            const { Terminal, FitAddon } = await loadXterm();

            this.xterm = new Terminal({
                cols: 80,
                rows: 24,
                convertEol: true,
                cursorBlink: true,
                scrollback: 3000,
                fontFamily: '"IBM Plex Mono","Courier New",monospace',
                fontSize: 13,
                theme: { background: '#1a1a1a', foreground: '#e5e5e5' }
            });
            
            this.fit = new FitAddon();
            this.xterm.loadAddon(this.fit);
            
            this.xterm.open(this.mount);

            const doFit = () => { 
                try { 
                    this.fit.fit(); 
                } catch(e) {
                    console.error('[TerminalApp] fit error:', e);
                } 
            };
            
            // Fit to actual container size after layout settles
            setTimeout(doFit, 300);
            
            this.ro = new ResizeObserver(() => {
                doFit();
            });
            this.ro.observe(this.output);

            // Write initial greeting to verify xterm is working
            this.xterm.write('\x1b[32mTerminal ready.\x1b[0m\r\n');
            
            if (this.pid) {
                this._attachPid(this.pid);
            } else {
                await this._startInteractiveShell();
            }

            setTimeout(() => {
                if (this.xterm) this.xterm.focus();
            }, 100);
        } catch (err) {
            console.error('[TerminalApp] _init failed:', err);
            // Fallback: show error in the mount element
            if (this.mount) {
                this.mount.textContent = 'Terminal init failed: ' + err.message;
                this.mount.style.color = '#ff4444';
                this.mount.style.padding = '10px';
            }
        }
    }

    _attachPid(pid) {
        if (this.isRuntime) {
            this._attachRuntimePid(pid);
        } else {
            this._attachBrowserPid(pid);
        }
    }

    _attachBrowserPid(pid) {
        // user input -> process
        this.xterm.onData((data) => {
            if (!this.pid) return;
            this.os.sendTtyInput(this.pid, data);
        });

        // process output -> xterm
        this.os.attachTty(pid, (payload) => {
            const data = payload?.data ?? '';
            this.byteCount += data.length;
            const title = this.win?.querySelector('.window-title');
            if (title) title.textContent = `Terminal (${pid}) [${this.byteCount} bytes]`;
            this.xterm.write(data);
        });
    }

    _attachRuntimePid(pid) {
        const runtime = this.os.runtime;
        
        // user input -> runtime process
        this.xterm.onData((data) => {
            if (!this.pid) return;
            runtime.write(this.pid, data);
        });

        // Track process for resize
        this.xterm.onResize(({ cols, rows }) => {
            if (this.pid) {
                runtime.resize(this.pid, cols, rows);
            }
        });

        // Attach to runtime process output
        runtime.attach(pid, (data, type) => {
            // type is 'stdout' or 'stderr'
            this.byteCount += data.length;
            const title = this.win?.querySelector('.window-title');
            if (title) title.textContent = `Runtime Terminal (${pid}) [${this.byteCount} bytes]`;
            
            // Color stderr red
            if (type === 'stderr') {
                this.xterm.write(`\x1b[31m${data}\x1b[0m`);
            } else {
                this.xterm.write(data);
            }
        }, (code, signal) => {
            // Process exited
            this.xterm.write(`\r\n\x1b[33m[Process exited with code ${code}${signal ? ` (${signal})` : ''}]\x1b[0m\r\n`);
            this.pid = null;
            this.isRuntime = false;
        });

        // Initial resize
        const dims = this.xterm.cols && this.xterm.rows 
            ? { cols: this.xterm.cols, rows: this.xterm.rows }
            : { cols: 80, rows: 24 };
        runtime.resize(pid, dims.cols, dims.rows);
    }

    async _startInteractiveShell() {
        // Dynamic import to avoid circular dependency with Shell
        const { Shell } = await import('../shell/Shell.js');

        // Track PIDs spawned from this terminal for TTY output
        this.attachedPids = new Set();

        // Create a headless Shell instance that prints into xterm
        this.shell = new Shell(this.os, {
            print: (msg, type = '') => {
                // simple type coloring (optional)
                if (type === 'error') this.xterm.write(`\x1b[31m${msg}\x1b[0m\r\n`);
                else if (type === 'success') this.xterm.write(`\x1b[32m${msg}\x1b[0m\r\n`);
                else if (type === 'system') this.xterm.write(`\x1b[36m${msg}\x1b[0m\r\n`);
                else this.xterm.write(`${msg}\r\n`);
            },
            write: (raw) => this.xterm.write(raw),
            clear: () => this.xterm.write('\x1b[2J\x1b[H'),
            // Attach TTY sink when a process is spawned from this terminal
            onSpawn: (pid, name) => {
                this.attachedPids.add(pid);
                this.os.setProcTtySink(pid, (payload) => {
                    const data = payload?.data ?? '';
                    this.xterm.write(data);
                });
                // Update title with process info
                const title = this.win?.querySelector('.window-title');
                if (title) title.textContent = `Terminal (${pid}: ${name.split('/').pop()})`;
            }
        });

        // greet + prompt
        this.xterm.write("MHNOS interactive shell (xterm). Type 'help' for commands.\r\n");
        this._syncPrompt();
        this._renderLine();

        this.xterm.onData(async (data) => {
            // handle pasted chunks too
            for (const ch of data) {
                await this._handleChar(ch);
            }
        });
        
        // Store shell reference for autocomplete
        this._shellClass = Shell;
    }

    _syncPrompt() {
        const cwd = this.shell?.cwd ?? '/';
        this.prompt = `user@mhnos:${cwd}$ `;
    }

    _renderLine() {
        // Clear the current line and re-draw prompt + buffer, then move cursor
        // \x1b[2K = clear entire line, \r = carriage return
        this.xterm.write('\x1b[2K\r');
        this.xterm.write(this.prompt + this.line);
        const target = this.prompt.length + this.cursor;
        const end = this.prompt.length + this.line.length;
        const back = end - target;
        if (back > 0) this.xterm.write(`\x1b[${back}D`);
    }

    async _handleChar(ch) {
        // Enter
        if (ch === '\r') {
            this.xterm.write('\r\n');
            const cmd = this.line;
            if (cmd.trim()) {
                this.history.push(cmd);
                this.histIdx = this.history.length;
            }
            this.line = '';
            this.cursor = 0;

            // Run command
            try {
                await this.shell.execute(cmd);
            } catch (e) {
                this.xterm.write(`\x1b[31m${e?.message ?? e}\x1b[0m\r\n`);
            }

            this._syncPrompt();
            this._renderLine();
            return;
        }

        // Backspace (DEL)
        if (ch === '\x7f') {
            if (this.cursor > 0) {
                this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
                this.cursor--;
                this._renderLine();
            }
            return;
        }

        // Ctrl+C -> cancel current line
        if (ch === '\x03') {
            this.xterm.write('^C\r\n');
            this.line = '';
            this.cursor = 0;
            this._renderLine();
            return;
        }

        // Escape sequences for arrows (xterm sends these)
        // We'll buffer simple 3-byte sequences: \x1b[A etc.
        if (ch === '\x1b') {
            this._esc = '\x1b';
            return;
        }
        if (this._esc) {
            this._esc += ch;
            // Wait until we have something like "\x1b[A" or "\x1b[1~"
            if (this._esc.length >= 3 && this._esc.startsWith('\x1b[')) {
                const seq = this._esc;
                this._esc = null;

                if (seq === '\x1b[A') { // up
                    if (this.history.length) {
                        this.histIdx = Math.max(0, this.histIdx - 1);
                        this.line = this.history[this.histIdx] ?? '';
                        this.cursor = this.line.length;
                        this._renderLine();
                    }
                    return;
                }
                if (seq === '\x1b[B') { // down
                    if (this.history.length) {
                        this.histIdx = Math.min(this.history.length, this.histIdx + 1);
                        this.line = (this.histIdx === this.history.length) ? '' : (this.history[this.histIdx] ?? '');
                        this.cursor = this.line.length;
                        this._renderLine();
                    }
                    return;
                }
                if (seq === '\x1b[C') { // right
                    this.cursor = Math.min(this.line.length, this.cursor + 1);
                    this._renderLine();
                    return;
                }
                if (seq === '\x1b[D') { // left
                    this.cursor = Math.max(0, this.cursor - 1);
                    this._renderLine();
                    return;
                }
                return;
            }
            // if not CSI, ignore
            return;
        }

        // Tab - autocomplete
        if (ch === '\t') {
            await this._doAutocomplete();
            return;
        }

        // Printable characters
        if (ch >= ' ' && ch !== '\x7f') {
            this.line = this.line.slice(0, this.cursor) + ch + this.line.slice(this.cursor);
            this.cursor++;
            this._renderLine();
        }
    }

    async _doAutocomplete() {
        // Get text before cursor
        const before = this.line.slice(0, this.cursor);
        const parts = before.split(/\s+/);
        const frag = parts[parts.length - 1] || '';
        
        // Command completion for first token
        if (parts.length === 1) {
            const matches = Object.keys(this.shell.commands)
                .filter(c => c.startsWith(frag))
                .sort();
            
            if (matches.length === 1) {
                // Complete the command
                this.line = matches[0] + ' ';
                this.cursor = this.line.length;
                this._renderLine();
            } else if (matches.length > 1) {
                // Show matches
                this.xterm.write('\r\n');
                this.xterm.write('\x1b[36m' + matches.join('  ') + '\x1b[0m');
                this.xterm.write('\r\n');
                this._syncPrompt();
                this._renderLine();
            }
            return;
        }
        
        // Path completion for 2nd+ token
        const lastSlash = frag.lastIndexOf('/');
        const dirPart = lastSlash >= 0 ? frag.slice(0, lastSlash + 1) : '';
        const baseFrag = lastSlash >= 0 ? frag.slice(lastSlash + 1) : frag;
        
        // Resolve directory to list
        const dirToList = dirPart ? this.shell.resolvePath(dirPart) : this.shell.cwd;
        
        // Import fs for listing
        const fs = await import('../../kernel/fs.js');
        const res = await fs.listFiles(dirToList);
        
        if (!res.success) return;
        
        const matches = res.data
            .map(ent => ent.name + (ent.type === 'directory' ? '/' : ''))
            .filter(name => name.startsWith(baseFrag))
            .sort();
        
        if (matches.length === 1) {
            // Complete the path
            const completed = dirPart + matches[0];
            parts[parts.length - 1] = completed;
            this.line = parts.join(' ') + (matches[0].endsWith('/') ? '' : ' ');
            this.cursor = this.line.length;
            this._renderLine();
        } else if (matches.length > 1) {
            // Show matches
            this.xterm.write('\r\n');
            this.xterm.write('\x1b[36m' + matches.join('  ') + '\x1b[0m');
            this.xterm.write('\r\n');
            this._syncPrompt();
            this._renderLine();
        }
    }

    detach() {
        if (this.isRuntime && this.pid) {
            // Detach from runtime process
            this.os.runtime.detach(this.pid);
        } else if (this.pid && this.os.ttyAttachedPid === this.pid) {
            this.os.detachTty();
        }
        // Clean up per-process TTY sinks for processes spawned from this terminal
        if (this.attachedPids) {
            for (const pid of this.attachedPids) {
                this.os.setProcTtySink(pid, null);
            }
            this.attachedPids.clear();
        }
        try { if (this.ro) this.ro.disconnect(); } catch {}
        try { if (this.xterm) this.xterm.dispose(); } catch {}
        this.pid = null;
        this.isRuntime = false;
        this.shell = null;
        this.xterm = null;
        this.fit = null;
        this.ro = null;
    }
}
