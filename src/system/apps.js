import * as fs from '../kernel/fs.js';

// --- HELPERS ---
function bufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function decodeBody(body) {
    if (typeof body === 'string') return body;
    return new TextDecoder().decode(body);
}

const LAUNCHER_CONFIG_PATH = '/system/launcher.json';
const TEXT_EXTENSIONS = new Set([
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
    'json', 'md', 'txt', 'css', 'html', 'htm',
    'yml', 'yaml', 'toml', 'xml', 'csv',
    'sh', 'bash', 'zsh', 'py', 'rb', 'go',
    'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp'
]);

function isLikelyTextPath(path) {
    const lower = path.toLowerCase();
    const dotIndex = lower.lastIndexOf('.');
    if (dotIndex === -1 || dotIndex === lower.length - 1) return true;
    const ext = lower.slice(dotIndex + 1);
    return TEXT_EXTENSIONS.has(ext);
}

async function readTextFileSafe(handle) {
    const file = await handle.getFile();
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const scanLen = Math.min(bytes.length, 1024);
    for (let i = 0; i < scanLen; i++) {
        if (bytes[i] === 0) return null;
    }
    const text = new TextDecoder().decode(buffer);
    return { text, size: file.size };
}

function buildSnippet(text, query, maxLen = 120) {
    const lower = text.toLowerCase();
    const idx = lower.indexOf(query);
    if (idx === -1) return text.slice(0, maxLen).replace(/\s+/g, ' ');
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, idx + query.length + 40);
    let snippet = text.slice(start, end).replace(/\s+/g, ' ');
    if (start > 0) snippet = '…' + snippet;
    if (end < text.length) snippet = snippet + '…';
    return snippet;
}

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderMarkdown(md) {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let inList = false;
    let listItemOpen = false;
    let inCode = false;
    let codeLang = '';
    let codeLines = [];
    let codeAsListItem = false;

    const closeList = () => {
        if (inList) {
            if (listItemOpen) {
                html += '</li>';
                listItemOpen = false;
            }
            html += '</ul>';
            inList = false;
        }
    };

    const makeCodeBlock = (lang, code) => {
        const safeLang = lang ? escapeHtml(lang) : '';
        const safeCode = escapeHtml(code);
        return (
            `<div class="nano-codeblock">` +
            `<button type="button" class="nano-copy">Copy</button>` +
            `<pre><code class="language-${safeLang}">${safeCode}</code></pre>` +
            `</div>`
        );
    };

    const formatInline = (text) => {
        let out = escapeHtml(text);
        const codeParts = [];
        out = out.replace(/`([^`]+)`/g, (match, code) => {
            const token = `@@INLINE_CODE_${codeParts.length}@@`;
            codeParts.push(`<code>${code}</code>`);
            return token;
        });
        out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        const segments = out.split(/(<[^>]+>)/g);
        out = segments.map((seg) => {
            if (seg.startsWith('<')) return seg;
            return seg.replace(/https?:\/\/[^\s<]+/g, (url) => {
                let clean = url;
                let tail = '';
                while (/[),.;!?]$/.test(clean)) {
                    tail = clean.slice(-1) + tail;
                    clean = clean.slice(0, -1);
                }
                return `<a href="${clean}" target="_blank" rel="noopener">${clean}</a>${tail}`;
            });
        }).join('');
        out = out.replace(/@@INLINE_CODE_(\d+)@@/g, (match, index) => codeParts[Number(index)] || '');
        return out;
    };

    for (const line of lines) {
        const trimmed = line.trim();
        if (inCode) {
            if (/^\s*```/.test(trimmed)) {
                const codeHtml = makeCodeBlock(codeLang, codeLines.join('\n'));
                if (codeAsListItem) {
                    if (!inList) {
                        html += '<ul>';
                        inList = true;
                    }
                    if (!listItemOpen) {
                        html += '<li>';
                        listItemOpen = true;
                    }
                    html += codeHtml;
                } else {
                    closeList();
                    html += codeHtml;
                }
                inCode = false;
                codeLang = '';
                codeLines = [];
                codeAsListItem = false;
                continue;
            }
            const contentLine = codeAsListItem ? line.replace(/^\s{2}/, '') : line;
            codeLines.push(contentLine);
            continue;
        }

        if (trimmed === '') {
            closeList();
            html += '<br>';
            continue;
        }

        const codeStartMatch = line.match(/^(\s*[-*+]\s+)?```(\w+)?\s*$/);
        if (codeStartMatch) {
            const hasListMarker = Boolean(codeStartMatch[1]);
            const isIndentedContinuation = !hasListMarker && inList && /^\s{2,}```/.test(line);
            codeAsListItem = hasListMarker || isIndentedContinuation;
            codeLang = codeStartMatch[2] || '';
            inCode = true;
            codeLines = [];
            continue;
        }

        const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
        if (headingMatch) {
            closeList();
            const level = headingMatch[1].length;
            html += `<h${level}>${formatInline(headingMatch[2])}</h${level}>`;
            continue;
        }

        const listMatch = line.match(/^\s*[-*+]\s+(.*)$/);
        if (listMatch) {
            if (!inList) {
                html += '<ul>';
                inList = true;
            }
            if (listItemOpen) {
                html += '</li>';
            }
            html += `<li>${formatInline(listMatch[1])}`;
            listItemOpen = true;
            continue;
        }

        const quoteMatch = line.match(/^\s*>\s+(.*)$/);
        if (quoteMatch) {
            closeList();
            html += `<blockquote>${formatInline(quoteMatch[1])}</blockquote>`;
            continue;
        }

        closeList();
        html += `<p>${formatInline(line)}</p>`;
    }

    if (inCode) {
        const codeHtml = makeCodeBlock(codeLang, codeLines.join('\n'));
        if (codeAsListItem) {
            if (!inList) {
                html += '<ul>';
                inList = true;
            }
            if (!listItemOpen) {
                html += '<li>';
                listItemOpen = true;
            }
            html += codeHtml;
        } else {
            closeList();
            html += codeHtml;
        }
    }

    closeList();
    return html;
}

// --- APP: FILE EXPLORER ---
export class FileExplorer {
    constructor(os) {
        this.os = os;
        this.currentPath = '/';
    }
    
    async open(startPath = '/') {
        this.currentPath = startPath;
        const win = this.os.wm.createWindow('File Explorer', this.render(), { width: 350, height: 400 });
        this.windowBody = win.querySelector('.window-body'); // Store ref to update later
        this.refresh();
    }
    
    render() {
        const div = document.createElement('div');
        div.style.cssText = "display:flex; flex-direction:column; height:100%; background:#fff; color:#000;";
        div.innerHTML = `
            <div style="padding:5px; border-bottom:1px solid #ccc; background:#f0f0f0; display:flex; gap:5px;">
                <button id="fe-up">⬆ Up</button>
                <input type="text" id="fe-path" value="${this.currentPath}" style="flex:1" readonly>
            </div>
            <div class="file-list" style="flex:1; overflow:auto; padding:5px;"></div>
        `;
        
        div.querySelector('#fe-up').onclick = () => this.goUp();
        return div;
    }
    
    goUp() {
        if(this.currentPath === '/') return;
        const parts = this.currentPath.split('/');
        parts.pop();
        this.currentPath = parts.join('/') || '/';
        this.refresh();
    }

    async refresh() {
        const listContainer = this.windowBody.querySelector('.file-list');
        const pathInput = this.windowBody.querySelector('#fe-path');
        
        pathInput.value = this.currentPath;
        listContainer.innerHTML = 'Loading...';
        
        const res = await fs.listFiles(this.currentPath);
        listContainer.innerHTML = '';

        if(res.data) {
            res.data.forEach(item => {
                const row = document.createElement('div');
                const isDir = item.type === 'directory';
                const icon = isDir ? '📁' : '📄';
                
                row.innerHTML = `<span style="margin-right:5px;">${icon}</span> ${item.name}`;
                row.style.cssText = "padding:6px; cursor:pointer; border-bottom:1px solid #eee; display:flex; align-items:center;";
                
                row.ondblclick = () => {
                    if(isDir) {
                        this.currentPath = this.currentPath === '/' 
                            ? `/${item.name}` 
                            : `${this.currentPath}/${item.name}`;
                        this.refresh();
                    } else {
                        // Open File
                        const fullPath = this.currentPath === '/' 
                            ? `/${item.name}` 
                            : `${this.currentPath}/${item.name}`;
                        this.os.shell.execute(`edit ${fullPath}`);
                    }
                };
                listContainer.appendChild(row);
            });
        }
    }
}

// --- APP: SETTINGS ---
export class SettingsApp {
    constructor(os) { this.os = os; }
    open() {
        const content = document.createElement('div');
        content.style.cssText = "padding:20px; color: var(--text-color);";
        content.innerHTML = `
            <h3>System Appearance</h3>
            <label>Accent Color:</label>
            <input type="color" id="set-accent" value="#0078d7"><br><br>
            <button id="set-dark">Dark Mode</button> 
            <button id="set-light">Light Mode</button><br><br>
            <label>Wallpaper URL:</label><br>
            <input type="text" id="set-bg" style="width:100%" placeholder="https://...">
        `;
        
        // Logic
        content.querySelector('#set-accent').onchange = (e) => {
            document.documentElement.style.setProperty('--os-accent', e.target.value);
        };
        content.querySelector('#set-dark').onclick = () => document.body.classList.add('dark-mode');
        content.querySelector('#set-light').onclick = () => document.body.classList.remove('dark-mode');
        content.querySelector('#set-bg').onchange = (e) => {
            document.documentElement.style.setProperty('--os-bg', `url('${e.target.value}')`);
        };

        this.os.wm.createWindow('Settings', content, { width: 300, height: 350 });
    }
}

// APP: Nano

export class Nano {
    constructor(os) { this.os = os; }
    
    open(filename = 'untitled.js', content = '', options = {}) {
        const width = Math.floor(window.innerWidth * 0.85);
        const height = Math.floor(window.innerHeight * 0.85);
        const x = (window.innerWidth - width) / 2;
        const y = (window.innerHeight - height) / 2;

        // Container (Uses CSS Grid)
        const div = document.createElement('div');
        div.className = 'nano-container';
        
        div.innerHTML = `
            <!-- Grid Row 1 -->
            <div class="nano-header">
                <div class="nano-title">MHN edit 2.0 | File: <span id="nano-filename">${filename}</span></div>
                <div class="nano-window-controls">
                    <button type="button" class="nano-btn-min" aria-label="Minimize"></button>
                    <button type="button" class="nano-btn-max" aria-label="Maximize"></button>
                    <button type="button" class="nano-btn-close" aria-label="Close"></button>
                </div>
            </div>

            <!-- Grid Row 2 (The Editor) -->
            <textarea id="nano-editor" class="nano-editor-textarea" spellcheck="false">${content}</textarea>
            <div id="nano-preview" class="nano-preview" style="display:none;"></div>

            <!-- Grid Row 3 -->
            <div class="nano-footer">
                <div class="nano-btn" id="btn-save">^S Save</div>
                <div class="nano-btn" id="btn-run">.</div>
                <div class="nano-btn" id="btn-preview">^M Preview</div>
                <div class="nano-btn" id="btn-exit">^X Exit</div>
            </div>
        `;

        const win = this.os.wm.createWindow('nano', div, { width, height, x, y });

        // Hide default TitleBar
        const wmHeader = win.querySelector('.window-header');
        if(wmHeader) wmHeader.style.display = 'none';
        
        // Attach drag
        div.querySelector('.nano-header').onmousedown = (e) => this.os.wm.startDrag(e, win);

        // Window controls
        div.querySelector('.nano-btn-close').onclick = () => this.os.wm.closeWindow(win);
        div.querySelector('.nano-btn-min').onclick = () => this.os.wm.minimizeWindow(win);
        div.querySelector('.nano-btn-max').onclick = () => this.os.wm.toggleMaximize(win);

        // Logic
        const editor = div.querySelector('#nano-editor');
        const preview = div.querySelector('#nano-preview');
        const getVal = () => editor.value;
        const updatePreview = () => {
            preview.innerHTML = renderMarkdown(getVal());
            preview.querySelectorAll('.nano-copy').forEach((btn) => {
                btn.onclick = async () => {
                    const code = btn.parentElement ? btn.parentElement.querySelector('code') : null;
                    if (!code) return;
                    const text = code.textContent || '';
                    try {
                        await navigator.clipboard.writeText(text);
                        btn.textContent = 'Copied';
                        setTimeout(() => { btn.textContent = 'Copy'; }, 1000);
                    } catch (e) {
                        const textarea = document.createElement('textarea');
                        textarea.value = text;
                        textarea.style.position = 'fixed';
                        textarea.style.opacity = '0';
                        document.body.appendChild(textarea);
                        textarea.select();
                        document.execCommand('copy');
                        textarea.remove();
                        btn.textContent = 'Copied';
                        setTimeout(() => { btn.textContent = 'Copy'; }, 1000);
                    }
                };
            });
        };
        let previewMode = false;
        const setPreviewMode = (enabled) => {
            previewMode = enabled;
            if (previewMode) {
                updatePreview();
                editor.style.display = 'none';
                preview.style.display = 'block';
                preview.scrollTop = 0;
                div.querySelector('#btn-preview').textContent = '^M Edit';
            } else {
                preview.style.display = 'none';
                editor.style.display = 'block';
                div.querySelector('#btn-preview').textContent = '^M Preview';
                setTimeout(() => editor.focus(), 0);
            }
        };

        div.querySelector('#btn-save').onclick = async () => {
            await fs.writeFile(filename, getVal());
            this.os.shell.print(`[edit] Wrote ${filename.length} bytes`, 'success');
        };
        div.querySelector('#btn-run').onclick = () => this.os.runCode(getVal());
        div.querySelector('#btn-preview').onclick = () => setPreviewMode(!previewMode);
        div.querySelector('#btn-exit').onclick = () => this.os.wm.closeWindow(win);

        editor.addEventListener('keydown', (e) => {
            if(e.key === 'Tab') {
                e.preventDefault();
                editor.setRangeText('    ', editor.selectionStart, editor.selectionStart, 'end');
            }
            if(e.ctrlKey && e.key === 's') { e.preventDefault(); div.querySelector('#btn-save').click(); }
            if(e.ctrlKey && e.key === 'r') { e.preventDefault(); div.querySelector('#btn-run').click(); }
            if(e.ctrlKey && e.key === 'x') { e.preventDefault(); div.querySelector('#btn-exit').click(); }
            if(e.ctrlKey && e.key === 'm') { e.preventDefault(); div.querySelector('#btn-preview').click(); }
        });
        
        if (options.preview) setPreviewMode(true);
        setTimeout(() => editor.focus(), 50);
    }
}

// --- APP: SYSTEM LOG (Console) ---
export class SystemLog {
    constructor(os) { this.os = os; }
    open() {
        // Only allow one log window
        if(document.getElementById('sys-log')) return;
        
        const div = document.createElement('div');
        div.id = 'sys-log';
        div.style.cssText = "background:#000; color:#0f0; height:100%; overflow:auto; padding:10px; font-family:monospace;";
        this.os.wm.createWindow('Kernel Log', div, { x: 500, y: 50, width: 400, height: 250 });
    }
    
    static log(msg) {
        const el = document.getElementById('sys-log');
        if(el) {
            const line = document.createElement('div');
            line.textContent = `> ${msg}`;
            el.appendChild(line);
            el.scrollTop = el.scrollHeight;
        }
    }
}

// --- APP: GRAPHICS DISPLAY ---
export class GfxDisplay {
    constructor(os) { this.os = os; }
    open() {
        if(document.getElementById('gfx-container')) return;

        const div = document.createElement('div');
        div.id = 'gfx-container';
        div.style.cssText = "width:100%; height:100%; background:#000; display:flex; justify-content:center; align-items:center;";
        this.os.wm.createWindow('Display', div, { x: 20, y: 400, width: 400, height: 340 });
    }
}


export class BrowserApp {
    constructor(os) { this.os = os; }

    open(initialUrl = 'localhost:3000') {
        const win = this.os.wm.createWindow('Web Browser', this.render(initialUrl), { width: 600, height: 450 });
        const viewport = win.querySelector('.browser-viewport');
        const input = win.querySelector('.url-bar');
        this.navigate(viewport, input.value, input);
    }

    render(url) {
        const div = document.createElement('div');
        div.style.cssText = "display:flex; flex-direction:column; height:100%;";
        div.innerHTML = `
            <div style="padding:8px; border-bottom:1px solid #333; background:#252526; display:flex; gap:8px;">
                <input type="text" class="url-bar" value="${url}" style="flex:1;">
                <button class="btn-go">Go</button>
            </div>
            <div class="browser-viewport" style="flex:1; overflow:hidden; background:white;"></div>
        `;
        div.querySelector('.btn-go').onclick = () => {
             const vp = div.querySelector('.browser-viewport');
             this.navigate(vp, div.querySelector('.url-bar').value);
        };
        return div;
    }

    async navigate(viewport, url) {
        viewport.innerHTML = `<div style="padding:20px; color:#666">Connecting to ${url}...</div>`;
        
        try {
            // 1. Fetch Root HTML
            const response = await this.os.fetch(url);
            
            if (response.statusCode !== 200) {
                viewport.innerHTML = `<div style="padding:20px; color:red">HTTP ${response.statusCode}: ${response.body}</div>`;
                return;
            }

            // 2. Parse into Virtual DOM
            const parser = new DOMParser();
            const htmlString = decodeBody(response.body);
            const doc = parser.parseFromString(htmlString, 'text/html');

            // 3. INLINE EVERYTHING (Prepare for Iframe)
            
            // A. CSS
            const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));
            for (const link of links) {
                const href = link.getAttribute('href');
                if (href && !href.startsWith('http')) {
                    const absUrl = this.resolveUrl(url, href);
                    try {
                        const res = await this.os.fetch(absUrl);
                        if(res.statusCode === 200) {
                            const css = decodeBody(res.body);
                            const style = doc.createElement('style');
                            style.textContent = css;
                            link.replaceWith(style);
                        }
                    } catch(e) { console.warn("Failed to load CSS", href); }
                }
            }

            // B. Scripts
            const scripts = Array.from(doc.querySelectorAll('script[src]'));
            for (const script of scripts) {
                const src = script.getAttribute('src');
                if (src && !src.startsWith('http')) {
                    const absUrl = this.resolveUrl(url, src);
                    try {
                        const res = await this.os.fetch(absUrl);
                        if(res.statusCode === 200) {
                            const js = decodeBody(res.body);
                            // Replace with inline script
                            script.removeAttribute('src');
                            script.textContent = js; 
                        }
                    } catch(e) { console.warn("Failed to load JS", src); }
                }
            }

            // C. Images
            const images = Array.from(doc.querySelectorAll('img[src]'));
            for (const img of images) {
                const src = img.getAttribute('src');
                if (src && !src.startsWith('http') && !src.startsWith('data:')) {
                    const absUrl = this.resolveUrl(url, src);
                    try {
                        const res = await this.os.fetch(absUrl);
                        if(res.statusCode === 200) {
                            // Ensure we have a Buffer/ArrayBuffer
                            let buffer = res.body;
                            if (typeof buffer === 'string') {
                                // If fs returned string, convert back to buffer (rare edge case in this setup)
                                buffer = new TextEncoder().encode(buffer);
                            }
                            const base64 = bufferToBase64(buffer);
                            const mime = res.headers ? res.headers['content-type'] : 'image/png';
                            img.src = `data:${mime};base64,${base64}`;
                        }
                    } catch(e) { console.warn("Failed to load Img", src); }
                }
            }

            // 4. Render to Iframe
            const finalHtml = doc.documentElement.outerHTML;
            const iframe = document.createElement('iframe');
            iframe.style.cssText = "width:100%; height:100%; border:none;";
            viewport.innerHTML = '';
            viewport.appendChild(iframe);
            
            // Write to iframe doc
            const frameDoc = iframe.contentWindow.document;
            frameDoc.open();
            frameDoc.write(finalHtml);
            frameDoc.close();

        } catch (e) {
            viewport.innerHTML = `<div style="padding:20px; color:red">Browser Error: ${e.message}</div>`;
            console.error(e);
        }
    }

    resolveUrl(baseUrl, relativePath) {
        const match = baseUrl.match(/(localhost:\d+)/);
        if(!match) return relativePath;
        const origin = match[1];
        const cleanPath = relativePath.replace(/^[\.\/]+/, '');
        return `${origin}/${cleanPath}`;
    }
}

export class LauncherApp {
    constructor(os) {
        this.os = os;
        this.window = null;
        this.searchIndex = null;
        this.indexPromise = null;
    }

    async open() {
        if (this.window && this.window.parentNode) {
            if (this.window.classList.contains('minimized')) this.os.wm.restoreWindow(this.window);
            else this.os.wm.focus(this.window);
            return;
        }

        const width = 360;
        const height = 520;
        const x = Math.max(20, window.innerWidth - width - 80);
        const y = Math.max(20, (window.innerHeight - height) / 2);

        const content = await this.render();
        this.window = this.os.wm.createWindow('Launcher', content, { width, height, x, y });
    }

    async render() {
        const wrapper = document.createElement('div');
        wrapper.className = 'launcher';
        wrapper.innerHTML = `
            <div class="launcher-header">
                <div class="launcher-title">Launcher</div>
                <button type="button" class="launcher-reindex">Reindex</button>
            </div>
            <div class="launcher-search">
                <div class="launcher-search-field">
                    <input type="text" class="launcher-search-input" placeholder="Search OPFS files...">
                    <button type="button" class="launcher-search-clear" aria-label="Clear search">×</button>
                </div>
                <div class="launcher-status">Indexing...</div>
                <div class="launcher-warning" hidden></div>
            </div>
            <div class="launcher-results" aria-live="polite"></div>
            <div class="launcher-section-title">Quick Launch</div>
            <div class="launcher-grid"></div>
        `;

        const searchInput = wrapper.querySelector('.launcher-search-input');
        const status = wrapper.querySelector('.launcher-status');
        const results = wrapper.querySelector('.launcher-results');
        const grid = wrapper.querySelector('.launcher-grid');
        const reindexBtn = wrapper.querySelector('.launcher-reindex');
        const clearBtn = wrapper.querySelector('.launcher-search-clear');
        const warning = wrapper.querySelector('.launcher-warning');

        const config = await this.loadConfig();
        this.renderLaunchCards(grid, config);

        this.buildSearchIndex(status, warning).then(() => {
            if (searchInput.value.trim()) this.runSearch(searchInput.value, results);
        });

        searchInput.addEventListener('input', () => this.runSearch(searchInput.value, results));
        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            results.innerHTML = '';
            searchInput.focus();
        });
        reindexBtn.addEventListener('click', async () => {
            this.searchIndex = null;
            this.indexPromise = null;
            results.innerHTML = '';
            const freshConfig = await this.loadConfig();
            this.renderLaunchCards(grid, freshConfig);
            this.buildSearchIndex(status, warning).then(() => {
                if (searchInput.value.trim()) this.runSearch(searchInput.value, results);
            });
        });

        return wrapper;
    }

    async loadConfig() {
        const res = await fs.readFile(LAUNCHER_CONFIG_PATH, true);
        if (res.success) {
            try {
                const config = JSON.parse(res.data);
                const items = Array.isArray(config.items) ? config.items : [];
                const addIfMissing = (item) => {
                    if (!items.some(existing => existing.id === item.id)) items.push(item);
                };
                addIfMissing({ id: 'browser', label: 'Browser', type: 'app', command: 'browser', icon: '🌐' });
                addIfMissing({ id: 'files', label: 'Files', type: 'app', command: 'files', icon: '📁' });
                addIfMissing({ id: 'link', label: 'Tools Menu', type: 'url', url: 'https://tools.mhn.lol', icon: '🔗' });
                addIfMissing({ id: 'life', label: 'Life Manager', type: 'url', url: 'https://lifeman.mhn.lol', icon: '🧭' });
                addIfMissing({ id: 'wget-md', label: 'wget-url.md', type: 'markdown', path: '/demos/utils/wget-url.md', icon: '📝' });
                addIfMissing({ id: 'readme-md', label: 'README', type: 'markdown', path: '/demos/utils/README.md', icon: '📘' });
                config.items = items;
                if (!config.version || config.version < 2) config.version = 2;
                await fs.writeFile(LAUNCHER_CONFIG_PATH, JSON.stringify(config, null, 2));
                return config;
            } catch (e) {
                this.os.shell.print(`[Launcher] Invalid config JSON. Resetting.`, 'error');
            }
        }

        await fs.createDir('/system');
        const defaultConfig = {
            version: 2,
            items: [
                { id: 'browser', label: 'Browser', type: 'app', command: 'browser', icon: '🌐' },
                { id: 'files', label: 'Files', type: 'app', command: 'files', icon: '📁' },
                { id: 'link', label: 'Tools Menu', type: 'url', url: 'https://tools.mhn.lol', icon: '🔗' },
                { id: 'life', label: 'Life Manager', type: 'url', url: 'https://lifeman.mhn.lol', icon: '🧭' },
                { id: 'wget-md', label: 'wget-url.md', type: 'markdown', path: '/demos/utils/wget-url.md', icon: '📝' },
                { id: 'readme-md', label: 'README', type: 'markdown', path: '/demos/utils/README.md', icon: '📘' }
            ]
        };
        await fs.writeFile(LAUNCHER_CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
        return defaultConfig;
    }

    renderLaunchCards(container, config) {
        container.innerHTML = '';
        if (!config || !Array.isArray(config.items)) return;
        config.items.forEach(item => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'launcher-card';
            card.innerHTML = `
                <div class="launcher-card-icon">${item.icon || '⬤'}</div>
                <div class="launcher-card-label">${item.label || item.id || 'Item'}</div>
            `;
            card.addEventListener('click', () => this.activateItem(item));
            container.appendChild(card);
        });
    }

    activateItem(item) {
        if (!item || !item.type) return;
        if (item.type === 'app' && item.command) {
            this.os.shell.execute(item.command);
            return;
        }
        if (item.type === 'markdown' && item.path) {
            this.os.shell.execute(`md ${item.path}`);
            return;
        }
        if (item.type === 'script' && item.path) {
            this.os.shell.execute(`run ${item.path}`);
            return;
        }
        if (item.type === 'url' && item.url) {
            window.open(item.url, '_blank', 'noopener');
        }
    }

    async buildSearchIndex(statusEl, warningEl = null) {
        if (this.searchIndex) {
            statusEl.textContent = `Indexed ${this.searchIndex.length} file(s)`;
            if (warningEl) warningEl.hidden = true;
            return this.searchIndex;
        }
        if (this.indexPromise) return this.indexPromise;

        statusEl.textContent = 'Indexing...';
        this.indexPromise = (async () => {
            let tree = [];
            try {
                tree = await fs.getFullTree();
                if (warningEl) warningEl.hidden = true;
            } catch (e) {
                statusEl.textContent = `Indexing disabled: ${e.message}`;
                if (warningEl) {
                    warningEl.hidden = false;
                    warningEl.textContent = 'OPFS unavailable. File search and sync are disabled in this browser or hosting context.';
                }
                return [];
            }
            const index = [];
            let processed = 0;

            for (const node of tree) {
                if (node.kind !== 'file') continue;
                if (!isLikelyTextPath(node.path)) continue;
                try {
                    const textRes = await readTextFileSafe(node.handle);
                    if (!textRes || !textRes.text) continue;
                    const text = textRes.text;
                    index.push({
                        path: node.path,
                        pathLower: node.path.toLowerCase(),
                        text,
                        textLower: text.toLowerCase()
                    });
                } catch (e) {
                    // Skip unreadable files
                }
                processed += 1;
                if (processed % 15 === 0) {
                    statusEl.textContent = `Indexing... (${processed})`;
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            this.searchIndex = index;
            statusEl.textContent = `Indexed ${index.length} file(s)`;
            return index;
        })();

        return this.indexPromise;
    }

    runSearch(rawQuery, resultsEl) {
        const query = rawQuery.trim().toLowerCase();
        resultsEl.innerHTML = '';
        if (!query) return;
        if (!this.searchIndex) {
            resultsEl.textContent = 'Indexing...';
            return;
        }

        const matches = [];
        for (const entry of this.searchIndex) {
            if (entry.pathLower.includes(query) || entry.textLower.includes(query)) {
                matches.push(entry);
                if (matches.length >= 50) break;
            }
        }

        if (matches.length === 0) {
            resultsEl.textContent = 'No matches.';
            return;
        }

        matches.forEach(entry => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'launcher-result';
            const snippet = buildSnippet(entry.text, query);
            row.innerHTML = `
                <div class="launcher-result-path">${entry.path}</div>
                <div class="launcher-result-snippet">${snippet}</div>
            `;
            row.addEventListener('click', () => {
                this.os.shell.execute(`edit ${entry.path}`);
            });
            resultsEl.appendChild(row);
        });
    }
}
