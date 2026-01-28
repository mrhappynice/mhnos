import * as fs from '../kernel/fs.js';
import { runCodingAgentFlow } from './appBuilderFlow.js';

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
        const width = Math.floor(window.innerWidth * 0.44);
        const height = Math.floor(window.innerHeight * 0.77);
        const x = (window.innerWidth - width) / 1.88;
        const y = (window.innerHeight - height) / 2.88;

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


// --- APP: APP BUILDER ---
export class AppBuilder {
    constructor(os) {
        this.os = os;
        this.state = this.loadState();
    }

    loadState() {
        // mirrors Search app approach: localStorage provider + per-provider keys :contentReference[oaicite:3]{index=3}
        const provider = localStorage.getItem('ab_provider') || 'lmstudio';
        const model = localStorage.getItem('ab_model') || '';
        const baseURL =
            localStorage.getItem('ab_baseURL') ||
            (provider === 'openai'
                ? 'https://api.openai.com'
                : provider === 'openrouter'
                ? 'https://openrouter.ai/api'
                : provider === 'llamacpp'
                ? 'http://localhost:8080'
                : 'http://localhost:1234');

        const systemPrompt =
            localStorage.getItem('ab_systemPrompt') ||
            `You are a coding agent working inside a browser-based OS.
Focus on modifying existing files when possible.
Prefer small, safe edits and keep the project runnable.
When you create new files, keep them minimal and documented.
Avoid build tools that require Node/Bun unless explicitly requested.`;

        const projectRoot =
            localStorage.getItem('ab_projectRoot') || '/apps/new-project';

        return { provider, model, baseURL, systemPrompt, projectRoot };
    }

    saveState() {
        localStorage.setItem('ab_provider', this.state.provider);
        localStorage.setItem('ab_model', this.state.model);
        localStorage.setItem('ab_baseURL', this.state.baseURL);
        localStorage.setItem('ab_systemPrompt', this.state.systemPrompt);
        if (this.state.projectRoot) {
            localStorage.setItem('ab_projectRoot', this.state.projectRoot);
        }
    }

    getApiKey(provider) {
        return localStorage.getItem('api_key_' + provider) || '';
    }

    setApiKey(provider, key) {
        if (!key) {
            localStorage.removeItem('api_key_' + provider);
        } else {
            localStorage.setItem('api_key_' + provider, key);
        }
    }

    providerConfig(provider) {
        // 4 options: lmstudio, llamacpp, openai, openrouter
        if (provider === 'openai') {
            return {
                modelsURL: 'https://api.openai.com/v1/models',
                chatURL: 'https://api.openai.com/v1/chat/completions',
                needsKey: true
            };
        }
        if (provider === 'openrouter') {
            return {
                modelsURL: 'https://openrouter.ai/api/v1/models',
                chatURL: 'https://openrouter.ai/api/v1/chat/completions',
                needsKey: true
            };
        }
        if (provider === 'llamacpp') {
            // OpenAI-compatible llama-server commonly: http://localhost:8080/v1/...
            // We keep baseURL editable in UI.
            return {
                modelsURL: `${this.state.baseURL}/v1/models`,
                chatURL: `${this.state.baseURL}/v1/chat/completions`,
                needsKey: false
            };
        }
        // lmstudio default (localhost:1234)
        return {
            modelsURL: `${this.state.baseURL}/v1/models`,
            chatURL: `${this.state.baseURL}/v1/chat/completions`,
            needsKey: false
        };
    }

    async fetchModels(provider, modelSelect, statusEl) {
        modelSelect.innerHTML = `<option>Loading...</option>`;

        const cfg = this.providerConfig(provider);
        const headers = {};

        // Search app uses Bearer key for non-local providers :contentReference[oaicite:4]{index=4}
        if (provider === 'openai' || provider === 'openrouter') {
            const key = this.getApiKey(provider);
            if (key) headers['Authorization'] = `Bearer ${key}`;
            if (provider === 'openrouter') {
                headers['HTTP-Referer'] = window.location.origin; // :contentReference[oaicite:5]{index=5}
                headers['X-Title'] = 'MHN OS AppBuilder';
            }
        }

        try {
            statusEl.textContent = `Fetching models from ${cfg.modelsURL}...`;
            const res = await fetch(cfg.modelsURL, { headers });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            const list = Array.isArray(data.data) ? data.data : [];
            if (list.length === 0) throw new Error('No models returned');

            modelSelect.innerHTML = list
                .map(m => `<option value="${m.id}">${m.id}</option>`)
                .join('');

            // Restore prior selection if present
            if (this.state.model && list.some(m => m.id === this.state.model)) {
                modelSelect.value = this.state.model;
            } else {
                this.state.model = modelSelect.value;
                this.saveState();
            }

            statusEl.textContent = `Models loaded (${list.length})`;
        } catch (e) {
            console.warn('[AppBuilder] fetchModels failed', e);
            modelSelect.innerHTML = `<option value="">(Default)</option>`;
            statusEl.textContent = `Model fetch failed: ${e.message}`;
        }
    }

    async streamChat({ provider, model, messages, onDelta, onStatus }) {
        const cfg = this.providerConfig(provider);
        const headers = { 'Content-Type': 'application/json' };

        if (provider === 'openai' || provider === 'openrouter') {
            const key = this.getApiKey(provider);
            if (!key) throw new Error(`Missing API key for ${provider}`);
            headers['Authorization'] = `Bearer ${key}`;
        }
        if (provider === 'openrouter') {
            headers['HTTP-Referer'] = window.location.origin; // :contentReference[oaicite:6]{index=6}
            headers['X-Title'] = 'MHN OS AppBuilder';
        }

        const body = {
            model: model || undefined,
            stream: true,
            messages
        };

        onStatus?.(`Connecting to ${cfg.chatURL} ...`);

        const res = await fetch(cfg.chatURL, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
        }

        // Stream parse the same "data: {json}" SSE style as Search app :contentReference[oaicite:7]{index=7}
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let sawDelta = false;
        let rawAll = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            rawAll += chunk;
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6).trim();
                if (payload === '[DONE]') return;

                try {
                    const json = JSON.parse(payload);
                    const delta = json.choices?.[0]?.delta?.content;
                    if (delta) {
                        sawDelta = true;
                        onDelta(delta);
                    }
                } catch {
                    // ignore malformed chunks
                }
            }
        }

        if (!sawDelta && rawAll.trim()) {
            try {
                const json = JSON.parse(rawAll);
                const content =
                    json.choices?.[0]?.message?.content ??
                    json.choices?.[0]?.text ??
                    '';
                if (content) onDelta(content);
            } catch {
                // ignore non-json responses
            }
        }
    }

    extractThreeFiles(text) {
        // Expect 3 fenced blocks: html/css/js
        const out = { html: '', css: '', js: '' };
        const re = /```(html|css|js)\n([\s\S]*?)```/g;
        let m;
        while ((m = re.exec(text))) {
            const lang = m[1];
            const body = (m[2] || '').trim();
            out[lang] = body;
        }
        return out;
    }

    buildPreviewSrcdoc(indexHtml, css, js) {
        // inline styles.css + app.js into the HTML so iframe works without network or file loading.
        // Replace <link rel="stylesheet" href="styles.css"> and <script src="app.js"></script>
        let html = indexHtml;

        html = html.replace(
            /<link[^>]*rel=["']stylesheet["'][^>]*href=["']styles\.css["'][^>]*>/i,
            `<style>\n${css}\n</style>`
        );

        html = html.replace(
            /<script[^>]*src=["']app\.js["'][^>]*>\s*<\/script>/i,
            `<script>\n${js}\n<\/script>`
        );

        // If they forgot the tags, just inject.
        if (!/<style[\s>]/i.test(html)) {
            html = html.replace(/<\/head>/i, `<style>\n${css}\n</style>\n</head>`);
        }
        if (!/<script[\s>]/i.test(html)) {
            html = html.replace(/<\/body>/i, `<script>\n${js}\n<\/script>\n</body>`);
        }

        return html;
    }

    async open() {
        const div = document.createElement('div');
        div.style.cssText =
            'display:flex; flex-direction:column; height:100%; padding:10px; gap:10px; background:#1e1e1e; color:#ddd;';

div.className = "ab-root";
div.innerHTML = `
  <div class="ab-header">
    <div class="ab-title">
      <div class="ab-title-main">Coding Agent</div>
      <div class="ab-title-sub">Plan → modify existing code → install deps → run</div>
    </div>
    <div class="ab-actions">
      <button class="ab-open">Open Folder</button>
      <button class="ab-add" disabled>Add to Launcher</button>
      <button class="ab-generate ab-primary">Run Agent</button>
    </div>
  </div>

  <details class="ab-panel ab-llm" open>
    <summary class="ab-summary">LLM Settings</summary>

    <div class="ab-grid">
      <label class="ab-field">
        <span>Provider</span>
        <select class="ab-provider">
          <option value="lmstudio">LM Studio (localhost:1234)</option>
          <option value="llamacpp">llama.cpp server (localhost:8080)</option>
          <option value="openai">OpenAI</option>
          <option value="openrouter">OpenRouter</option>
        </select>
      </label>

      <label class="ab-field">
        <span>Base URL</span>
        <input class="ab-baseurl" placeholder="http://localhost:1234" />
      </label>

      <label class="ab-field">
        <span>Model</span>
        <select class="ab-model"><option>Loading...</option></select>
      </label>

      <label class="ab-field">
        <span>API Key</span>
        <input class="ab-key" type="password" placeholder="sk-..." />
      </label>

      <label class="ab-field ab-wide">
        <span>System Prompt</span>
        <textarea class="ab-sys" rows="4"></textarea>
      </label>
    </div>
  </details>

  <div class="ab-row">
    <label class="ab-field ab-name">
      <span>App folder</span>
      <input class="ab-name-input" placeholder="/apps/my-project" />
    </label>
    <label class="ab-field ab-name">
      <span>Existing apps</span>
      <select class="ab-app-list"><option value="">(loading...)</option></select>
    </label>
    <label class="ab-field ab-name">
      <span>New app</span>
      <div style="display:flex; gap:6px;">
        <input class="ab-new-app" placeholder="new-app" />
        <button class="ab-create-app">Create</button>
      </div>
    </label>
    <div class="ab-status">Idle</div>
  </div>

  <div class="ab-main">
    <section class="ab-pane ab-prompt-pane">
      <div class="ab-pane-head">Goal</div>
      <textarea class="ab-prompt" placeholder="Describe what you want changed or built..."></textarea>
    </section>

    <section class="ab-pane ab-log-pane">
      <div class="ab-pane-head">Agent Log</div>
      <pre class="ab-log"></pre>
    </section>

    <section class="ab-pane ab-preview-pane">
      <div class="ab-pane-head">Preview</div>
      <iframe class="ab-preview"></iframe>
    </section>
  </div>
`;


        this.os.wm.createWindow('Coding Agent', div, { width: 980, height: 760 });

        const providerEl = div.querySelector('.ab-provider');
        const baseUrlEl = div.querySelector('.ab-baseurl');
        const modelEl = div.querySelector('.ab-model');
        const keyEl = div.querySelector('.ab-key');
        const nameEl = div.querySelector('.ab-name-input');
        const appListEl = div.querySelector('.ab-app-list');
        const newAppEl = div.querySelector('.ab-new-app');
        const createAppBtn = div.querySelector('.ab-create-app');
        const promptEl = div.querySelector('.ab-prompt');
        const sysEl = div.querySelector('.ab-sys');
        const statusEl = div.querySelector('.ab-status');
        const logEl = div.querySelector('.ab-log');
        const frameEl = div.querySelector('.ab-preview');
        const genBtn = div.querySelector('.ab-generate');
        const openBtn = div.querySelector('.ab-open');
        const addBtn = div.querySelector('.ab-add');
        let lastGenerated = null;

        const toTitle = (text) => text
            .split('-')
            .filter(Boolean)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');

        const findIndexHtml = async (root, depth = 3) => {
            const queue = [{ path: root, depth }];
            while (queue.length) {
                const { path, depth: d } = queue.shift();
                const res = await fs.listFiles(path);
                if (!res || !res.success || !Array.isArray(res.data)) continue;
                for (const entry of res.data) {
                    const full = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
                    if (entry.type === 'file' && entry.name === 'index.html') {
                        return full;
                    }
                    if (entry.type === 'directory' && d > 0) {
                        queue.push({ path: full, depth: d - 1 });
                    }
                }
            }
            return null;
        };

        const addToLauncher = async ({ slug, appDir, label }) => {
            const command = `oapp ${appDir}`;
            let config = { version: 2, items: [] };
            const res = await fs.readFile(LAUNCHER_CONFIG_PATH, true);
            if (res && res.success && res.data) {
                try {
                    config = JSON.parse(res.data);
                } catch (e) {
                    // fall back to fresh config
                }
            }
            if (!Array.isArray(config.items)) config.items = [];
            const item = {
                id: `app-${slug}`,
                label,
                type: 'app',
                command,
                icon: '🧩'
            };
            const existing = config.items.find(entry => entry.id === item.id || entry.command === item.command);
            if (existing) Object.assign(existing, item);
            else config.items.push(item);
            if (!config.version || config.version < 2) config.version = 2;

            await fs.createDir('/system');
            await fs.writeFile(LAUNCHER_CONFIG_PATH, JSON.stringify(config, null, 2));
        };

        // Init UI from saved state
        providerEl.value = this.state.provider;
        baseUrlEl.value = this.state.baseURL;
        sysEl.value = this.state.systemPrompt;
        keyEl.value = this.getApiKey(this.state.provider) || '';
        nameEl.value = this.state.projectRoot || '';

        const syncKeyField = () => {
            const p = providerEl.value;
            const needsKey = p === 'openai' || p === 'openrouter';
            keyEl.disabled = !needsKey;
            keyEl.placeholder = needsKey ? 'sk-...' : '(not required)';
            keyEl.value = this.getApiKey(p) || '';
        };

        const refreshModels = async () => {
            this.state.provider = providerEl.value;

            // baseURL used for local providers
            this.state.baseURL = baseUrlEl.value.trim() || this.state.baseURL;

            syncKeyField();
            this.saveState();

            await this.fetchModels(this.state.provider, modelEl, statusEl);
        };

        providerEl.addEventListener('change', refreshModels);
        baseUrlEl.addEventListener('change', () => {
            this.state.baseURL = baseUrlEl.value.trim() || this.state.baseURL;
            this.saveState();
            refreshModels();
        });

        modelEl.addEventListener('change', () => {
            this.state.model = modelEl.value;
            this.saveState();
        });

        keyEl.addEventListener('change', () => {
            this.setApiKey(providerEl.value, keyEl.value.trim());
        });

        nameEl.addEventListener('change', () => {
            this.state.projectRoot = (nameEl.value || '').trim();
            this.saveState();
        });

        sysEl.addEventListener('change', () => {
            this.state.systemPrompt = sysEl.value;
            this.saveState();
        });

        const resolveProjectPath = () => {
            const raw = (nameEl.value || '').trim() || '/apps/new-project';
            let normalized = raw;
            if (!normalized.startsWith('/')) normalized = `/apps/${normalized.replace(/^\/+/, '')}`;
            if (!normalized.startsWith('/apps/')) {
                normalized = `/apps/${normalized.replace(/^\/+/, '')}`;
            }
            return normalized.replace(/\/+$/, '');
        };

        const projectSlugFromPath = (path) => {
            const clean = path.replace(/\/+$/, '');
            const parts = clean.split('/').filter(Boolean);
            return parts[parts.length - 1] || 'project';
        };

        const refreshAppList = async () => {
            const res = await fs.listFiles('/apps');
            if (!res || !res.success || !Array.isArray(res.data)) {
                appListEl.innerHTML = `<option value="">(no /apps)</option>`;
                return;
            }
            const apps = res.data.filter((e) => e.type === 'directory').map((e) => e.name);
            appListEl.innerHTML = `<option value="">(select app)</option>` +
                apps.map((name) => `<option value="${name}">${name}</option>`).join('');
        };

        appListEl.addEventListener('change', () => {
            const name = appListEl.value;
            if (!name) return;
            nameEl.value = `/apps/${name}`;
            this.state.projectRoot = nameEl.value;
            this.saveState();
        });

        createAppBtn.onclick = async () => {
            const raw = (newAppEl.value || '').trim();
            if (!raw) return;
            const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            const path = `/apps/${slug}`;
            await fs.createDir('/apps');
            await fs.createDir(path);
            nameEl.value = path;
            this.state.projectRoot = path;
            this.saveState();
            newAppEl.value = '';
            await refreshAppList();
        };

        openBtn.onclick = () => {
            const root = resolveProjectPath();
            this.os.shell.execute(`files ${root}`);
        };

        addBtn.onclick = async () => {
            if (!lastGenerated) return;
            try {
                await addToLauncher(lastGenerated);
                statusEl.textContent = `Added "${lastGenerated.label}" to launcher`;
                this.os.shell.print(`[AppBuilder] Added ${lastGenerated.appDir} to launcher`, 'success');
            } catch (e) {
                statusEl.textContent = `Launcher update failed: ${e.message}`;
                this.os.shell.print(`[AppBuilder] Launcher update failed: ${e.message}`, 'error');
            }
        };

        // First model load
        await refreshModels();
        await refreshAppList();

        genBtn.onclick = async () => {
            logEl.textContent = '';
            frameEl.srcdoc = '';
            frameEl.src = '';
            let logPhase = null;
            const appendLog = (chunk, phase) => {
                const nextPhase = phase || 'generate';
                if (nextPhase !== logPhase) {
                    logPhase = nextPhase;
                    logEl.textContent += `\n\n[${logPhase.toUpperCase()}]\n`;
                }
                logEl.textContent += chunk;
                logEl.scrollTop = logEl.scrollHeight;
            };

            const projectRoot = resolveProjectPath();
            const slug = projectSlugFromPath(projectRoot);

            const userPrompt = (promptEl.value || '').trim();
            if (!userPrompt) {
                statusEl.textContent = 'Enter a prompt.';
                return;
            }

            // Persist current selections
            this.state.provider = providerEl.value;
            this.state.baseURL = baseUrlEl.value.trim() || this.state.baseURL;
            this.state.model = modelEl.value || this.state.model;
            this.state.systemPrompt = sysEl.value;
            this.state.projectRoot = projectRoot;
            this.saveState();
            this.setApiKey(this.state.provider, keyEl.value.trim());

            try {
                const listRes = await fs.listFiles(projectRoot);
                const strictRoot = projectRoot.startsWith('/apps/') && listRes && listRes.success && Array.isArray(listRes.data) && listRes.data.length === 0;

                const { finalSummary } = await runCodingAgentFlow({
                    prompt: userPrompt,
                    fs,
                    os: this.os,
                    projectRoot,
                    systemPrompt: this.state.systemPrompt,
                    strictRoot,
                    llm: ({ messages, onDelta }) =>
                        this.streamChat({
                            provider: this.state.provider,
                            model: this.state.model,
                            messages,
                            onStatus: (s) => (statusEl.textContent = s),
                            onDelta
                        }),
                    onLog: appendLog,
                    onStatus: (s) => (statusEl.textContent = s),
                    maxSteps: 10
                });

                const htmlRes = await fs.readFile(`${projectRoot}/index.html`, true);
                const isAppsProject = projectRoot.startsWith('/apps/');
                if (htmlRes.success && isAppsProject) {
                    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
                        try { await navigator.serviceWorker.ready; } catch {}
                    }
                    frameEl.src = `${projectRoot}/index.html`;
                } else if (htmlRes.success) {
                    const cssRes = await fs.readFile(`${projectRoot}/styles.css`, true);
                    const jsRes = await fs.readFile(`${projectRoot}/app.js`, true);
                    const css = (cssRes && cssRes.success) ? (cssRes.data || '') : '';
                    const js = (jsRes && jsRes.success) ? (jsRes.data || '') : '';
                    const srcdoc = this.buildPreviewSrcdoc(htmlRes.data, css, js);
                    frameEl.srcdoc = srcdoc;
                } else {
                    const fallback = await findIndexHtml(projectRoot, 4);
                    if (fallback) {
                        const base = fallback.slice(0, fallback.lastIndexOf('/'));
                        const htmlAlt = await fs.readFile(fallback, true);
                        if (htmlAlt && htmlAlt.success && base.startsWith('/apps/')) {
                            if (navigator.serviceWorker && navigator.serviceWorker.ready) {
                                try { await navigator.serviceWorker.ready; } catch {}
                            }
                            frameEl.src = `${base}/index.html`;
                            appendLog(`\n[WARN] index.html not found at root. Previewing ${fallback}\n`, 'warn');
                        } else if (htmlAlt && htmlAlt.success) {
                            const cssAlt = await fs.readFile(`${base}/styles.css`, true);
                            const jsAlt = await fs.readFile(`${base}/app.js`, true);
                            const css = (cssAlt && cssAlt.success) ? (cssAlt.data || '') : '';
                            const js = (jsAlt && jsAlt.success) ? (jsAlt.data || '') : '';
                            const srcdoc = this.buildPreviewSrcdoc(htmlAlt.data, css, js);
                            frameEl.srcdoc = srcdoc;
                            appendLog(`\n[WARN] index.html not found at root. Previewing ${fallback}\n`, 'warn');
                        } else {
                            frameEl.srcdoc = `<div style=\"padding:12px;color:#999;font-family:monospace;\">No previewable index.html found in ${projectRoot}.</div>`;
                        }
                    } else {
                        frameEl.srcdoc = `<div style=\"padding:12px;color:#999;font-family:monospace;\">No previewable index.html found in ${projectRoot}.</div>`;
                    }
                }

                if (finalSummary && finalSummary.summary) {
                    statusEl.textContent = 'Completed';
                    appendLog(`\n[SUMMARY]\n${finalSummary.summary}\n`, 'summary');
                } else {
                    statusEl.textContent = 'Completed';
                }

                if (projectRoot.startsWith('/apps/')) {
                    lastGenerated = { slug, appDir: projectRoot, label: toTitle(slug) };
                    addBtn.disabled = false;
                } else {
                    lastGenerated = null;
                    addBtn.disabled = true;
                }
            } catch (e) {
                statusEl.textContent = `Error: ${e.message}`;
                this.os.shell.print(`[AppBuilder] ${e.message}`, 'error');
                console.error(e);
            }
        };
    }
}




export class BrowserApp {
    constructor(os) {
        this.os = os;
        this.messageHandler = null;
        this.currentFrame = null;
        this.urlInput = null;
        this.viewport = null;
    }

    open(initialUrl = 'localhost:3000') {
        const win = this.os.wm.createWindow('Web Browser', this.render(initialUrl), { width: 600, height: 450 });
        this.viewport = win.querySelector('.browser-viewport');
        this.urlInput = win.querySelector('.url-bar');
        this.attachMessageBridge();
        this.navigate(this.viewport, this.urlInput.value, this.urlInput);
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
             this.navigate(vp, div.querySelector('.url-bar').value, div.querySelector('.url-bar'));
        };
        return div;
    }

    attachMessageBridge() {
        if (this.messageHandler) return;
        this.messageHandler = (event) => {
            const data = event && event.data ? event.data : null;
            if (!data || data.type !== 'MHNOS_NAVIGATE') return;
            if (!this.currentFrame || event.source !== this.currentFrame.contentWindow) return;
            if (!data.url || typeof data.url !== 'string') return;
            if (this.urlInput) this.urlInput.value = data.url;
            if (this.viewport) this.navigate(this.viewport, data.url, this.urlInput);
        };
        window.addEventListener('message', this.messageHandler);
    }

    async navigate(viewport, url, input = null) {
        viewport.innerHTML = `<div style="padding:20px; color:#666">Connecting to ${url}...</div>`;
        
        try {
            let target = (url || '').trim();
            if (!target) {
                viewport.innerHTML = `<div style="padding:20px; color:red">Missing URL</div>`;
                return;
            }
            if (!target.startsWith('http') && !target.startsWith('/') && !target.startsWith('localhost')) {
                target = '/' + target;
                if (input) input.value = target;
            }
            if (target.startsWith('/')) {
                const iframe = document.createElement('iframe');
                iframe.style.cssText = "width:100%; height:100%; border:none;";
                viewport.innerHTML = '';
                viewport.appendChild(iframe);
                this.currentFrame = iframe;
                iframe.src = target;
                return;
            }
            // 1. Fetch Root HTML
            const response = await this.os.fetch(target);
            
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
                    const absUrl = this.resolveUrl(target, href);
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
                    const absUrl = this.resolveUrl(target, src);
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
                    const absUrl = this.resolveUrl(target, src);
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
            this.currentFrame = iframe;
            
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
        if (baseUrl.startsWith('/')) {
            const baseDir = baseUrl.endsWith('/') ? baseUrl : baseUrl.slice(0, baseUrl.lastIndexOf('/') + 1);
            const cleanRel = relativePath.replace(/^[\.\/]+/, '');
            return baseDir + cleanRel;
        }
        const match = baseUrl.match(/(localhost:\d+)/);
        if(!match) return relativePath;
        const origin = match[1];
        const cleanPath = relativePath.replace(/^[\.\/]+/, '');
        return `${origin}/${cleanPath}`;
    }
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
    }

    open(pid) {
        this.pid = pid || null;
        const container = document.createElement('div');
        container.style.cssText = 'display:flex; flex-direction:column; height:100%; background:#0b0b0b;';
        container.tabIndex = 0;

        const output = document.createElement('div');
        output.style.cssText = 'flex:1; overflow:hidden;';
        container.appendChild(output);

        this.term = new TerminalEmulator(output, 100, 30);

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
            this.term.write(data);
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
                addIfMissing({ id: 'appbuilder', label: 'Coding Agent', type: 'app', command: 'appbuilder', icon: '🧪' });
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
                { id: 'appbuilder', label: 'Coding Agent', type: 'app', command: 'appbuilder', icon: '🧪' },
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
