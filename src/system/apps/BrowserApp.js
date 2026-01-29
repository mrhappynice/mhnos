import { bufferToBase64, decodeBody } from './helpers.js';

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
