import * as fs from '../../kernel/fs.js';
import { renderMarkdown } from './helpers.js';

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
