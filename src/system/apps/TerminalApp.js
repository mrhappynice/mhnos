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
    }

    open(pid) {
        this.pid = pid || null;
        const container = document.createElement('div');
        container.style.cssText = [
  'display:flex',
  'flex-direction:column',
  'height:100%',
  'width:100%',
  'min-height:0'          // important in nested flex layouts
].join(';');
        container.tabIndex = 0;

        const output = document.createElement('div');
        output.style.cssText = [
  'flex:1',
  'min-height:0',   
  'overflow:auto'
].join(';');
        container.appendChild(output);

        this.pre = document.createElement('pre');
this.pre.style.cssText = [
  'margin:0',
  'padding:10px',
  'font-family:"IBM Plex Mono", "Courier New", monospace',
  'font-size:13px',
  'line-height:1.4',
  'color:#e5e5e5',
  'white-space:pre-wrap',   // <- wraps like a log; use 'pre' if you want no wrapping
  'user-select:text'
].join(';');
output.appendChild(this.pre);
this.output = output;


        container.addEventListener('click', () => container.focus());
        container.addEventListener('keydown', (e) => {
            if (!this.pid) return;
            const seq = this.translateKey(e);
            if (seq) {
                e.preventDefault();
                this.os.sendTtyInput(this.pid, seq);
            }
        });

        this.byteCount = 0;
        this.win = this.os.wm.createWindow(`Terminal ${pid ? `(${pid})` : ''}`, container, { width: 720, height: 460 });
        this.win.querySelector('.btn-close').addEventListener('click', () => this.detach());

        if (this.pid) this.attach(this.pid);
        setTimeout(() => container.focus(), 50);
    }

    attach(pid) {
        this.pid = pid;
        this.os.attachTty(pid, (payload) => {
            const data = payload && payload.data ? payload.data : '';
            this.byteCount += data.length;
            const title = this.win.querySelector('.window-title');
            if (title) title.textContent = `Terminal (${pid}) [${this.byteCount} bytes]`;
            this.pre.textContent += data;
            this.output.scrollTop = this.output.scrollHeight;

        });
    }

    detach() {
        if (this.pid && this.os.ttyAttachedPid === this.pid) {
            this.os.detachTty();
        }
        this.pid = null;
    }

    translateKey(e) {
        if (e.ctrlKey && e.key === 'c') return '\x03';
        if (e.key === 'Enter') return '\r';
        if (e.key === 'Backspace') return '\x7f';
        if (e.key === 'Tab') return '\t';
        if (e.key === 'Escape') return '\x1b';
        if (e.key === 'ArrowUp') return '\x1b[A';
        if (e.key === 'ArrowDown') return '\x1b[B';
        if (e.key === 'ArrowRight') return '\x1b[C';
        if (e.key === 'ArrowLeft') return '\x1b[D';
        if (e.key && e.key.length === 1 && !e.metaKey && !e.ctrlKey) return e.key;
        return '';
    }
}

