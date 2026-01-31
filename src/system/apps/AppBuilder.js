import * as fs from '../../kernel/fs.js';
import { runCodingAgentFlow } from '../appBuilderFlow.js';

const LAUNCHER_CONFIG_PATH = '/system/launcher.json';
const SYSTEM_CONTEXT_PATH = '/system/agent_context.md';

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

        const useSystemContext = localStorage.getItem('ab_useSystemContext') !== 'false';
        const confirmTools = localStorage.getItem('ab_confirmTools') !== 'false';
        const autoVerify = localStorage.getItem('ab_autoVerify') === 'true';
        const writeScope = localStorage.getItem('ab_writeScope') || 'project';

        return { provider, model, baseURL, systemPrompt, projectRoot, useSystemContext, confirmTools, autoVerify, writeScope };
    }

    saveState() {
        localStorage.setItem('ab_provider', this.state.provider);
        localStorage.setItem('ab_model', this.state.model);
        localStorage.setItem('ab_baseURL', this.state.baseURL);
        localStorage.setItem('ab_systemPrompt', this.state.systemPrompt);
        if (this.state.projectRoot) {
            localStorage.setItem('ab_projectRoot', this.state.projectRoot);
        }
        localStorage.setItem('ab_useSystemContext', this.state.useSystemContext ? 'true' : 'false');
        localStorage.setItem('ab_confirmTools', this.state.confirmTools ? 'true' : 'false');
        localStorage.setItem('ab_autoVerify', this.state.autoVerify ? 'true' : 'false');
        localStorage.setItem('ab_writeScope', this.state.writeScope || 'project');
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

    buildPreviewSrcdoc(indexHtml) {
        return indexHtml || '';
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

      <label class="ab-field ab-wide">
        <span>System Context</span>
        <div style="display:flex; gap:8px; align-items:center;">
          <input type="checkbox" class="ab-context-toggle" />
          <span>Use ${SYSTEM_CONTEXT_PATH}</span>
        </div>
      </label>

      <label class="ab-field ab-wide">
        <span>Agent Behavior</span>
        <div style="display:flex; gap:14px; align-items:center;">
          <label style="display:flex; gap:6px; align-items:center;">
            <input type="checkbox" class="ab-confirm-tools" />
            <span>Confirm tool use</span>
          </label>
          <label style="display:flex; gap:6px; align-items:center;">
            <input type="checkbox" class="ab-auto-verify" />
            <span>Auto-verify (oapp build)</span>
          </label>
          <label style="display:flex; gap:6px; align-items:center;">
            <span>Write scope</span>
            <select class="ab-write-scope">
              <option value="project">Project only</option>
              <option value="opfs">Any OPFS path</option>
            </select>
          </label>
        </div>
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
    <section class="ab-pane ab-chat-pane">
      <div class="ab-pane-head">Chat</div>
      <div class="ab-chat-log"></div>
      <div class="ab-chat-input">
        <textarea class="ab-prompt" placeholder="Ask about the system or request a change..."></textarea>
        <button class="ab-generate ab-primary">Send</button>
      </div>
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
        const contextToggleEl = div.querySelector('.ab-context-toggle');
        const confirmToolsEl = div.querySelector('.ab-confirm-tools');
        const autoVerifyEl = div.querySelector('.ab-auto-verify');
        const writeScopeEl = div.querySelector('.ab-write-scope');
        const statusEl = div.querySelector('.ab-status');
        const chatLogEl = div.querySelector('.ab-chat-log');
        const frameEl = div.querySelector('.ab-preview');
        const genBtn = div.querySelector('.ab-generate');
        const openBtn = div.querySelector('.ab-open');
        const addBtn = div.querySelector('.ab-add');
        let lastGenerated = null;
        let logPhase = null;
        let streamEl = null;

        const addMessage = (role, text) => {
            const el = document.createElement('div');
            el.className = `ab-msg ab-msg-${role}`;
            el.textContent = text || '';
            if (role === 'assistant') {
                const copyBtn = document.createElement('button');
                copyBtn.className = 'ab-copy';
                copyBtn.textContent = 'Copy';
                copyBtn.onclick = async (e) => {
                    e.stopPropagation();
                    const content = el.textContent || '';
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        try { await navigator.clipboard.writeText(content); } catch {}
                    }
                };
                el.appendChild(copyBtn);
            }
            chatLogEl.appendChild(el);
            chatLogEl.scrollTop = chatLogEl.scrollHeight;
            return el;
        };

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
        contextToggleEl.checked = !!this.state.useSystemContext;
        confirmToolsEl.checked = !!this.state.confirmTools;
        autoVerifyEl.checked = !!this.state.autoVerify;
        writeScopeEl.value = this.state.writeScope || 'project';

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

        contextToggleEl.addEventListener('change', () => {
            this.state.useSystemContext = !!contextToggleEl.checked;
            this.saveState();
        });

        confirmToolsEl.addEventListener('change', () => {
            this.state.confirmTools = !!confirmToolsEl.checked;
            this.saveState();
        });

        autoVerifyEl.addEventListener('change', () => {
            this.state.autoVerify = !!autoVerifyEl.checked;
            this.saveState();
        });

        writeScopeEl.addEventListener('change', () => {
            this.state.writeScope = writeScopeEl.value || 'project';
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
            frameEl.srcdoc = '';
            frameEl.src = '';
            logPhase = null;
            streamEl = null;
            const appendLog = (chunk, phase) => {
                const nextPhase = phase || 'agent';
                if (!streamEl) streamEl = addMessage('assistant', '');
                if (nextPhase !== logPhase) {
                    logPhase = nextPhase;
                    streamEl.textContent += `\n[${logPhase.toUpperCase()}]\n`;
                }
                streamEl.textContent += chunk;
                chatLogEl.scrollTop = chatLogEl.scrollHeight;
            };

            const projectRoot = resolveProjectPath();
            const slug = projectSlugFromPath(projectRoot);

            const userPrompt = (promptEl.value || '').trim();
            if (!userPrompt) {
                statusEl.textContent = 'Enter a prompt.';
                return;
            }
            addMessage('user', userPrompt);
            promptEl.value = '';

            // Persist current selections
            this.state.provider = providerEl.value;
            this.state.baseURL = baseUrlEl.value.trim() || this.state.baseURL;
            this.state.model = modelEl.value || this.state.model;
            this.state.systemPrompt = sysEl.value;
            this.state.projectRoot = projectRoot;
            this.state.useSystemContext = !!contextToggleEl.checked;
            this.state.confirmTools = !!confirmToolsEl.checked;
            this.state.autoVerify = !!autoVerifyEl.checked;
            this.state.writeScope = writeScopeEl.value || 'project';
            this.saveState();
            this.setApiKey(this.state.provider, keyEl.value.trim());

            try {
                let systemContext = '';
                if (this.state.useSystemContext) {
                    const ctxRes = await fs.readFile(SYSTEM_CONTEXT_PATH, true);
                    if (ctxRes && ctxRes.success && typeof ctxRes.data === 'string') {
                        systemContext = ctxRes.data;
                    } else {
                        appendLog(`\n[WARN] Missing system context at ${SYSTEM_CONTEXT_PATH}\n`, 'warn');
                    }
                }

                const listRes = await fs.listFiles(projectRoot);
                const strictRoot = projectRoot.startsWith('/apps/') && listRes && listRes.success && Array.isArray(listRes.data) && listRes.data.length === 0;

                const { finalSummary } = await runCodingAgentFlow({
                    prompt: userPrompt,
                    fs,
                    os: this.os,
                    projectRoot,
                    systemPrompt: this.state.systemPrompt,
                    systemContext,
                    strictRoot,
                    requireApproval: this.state.confirmTools,
                    verify: this.state.autoVerify,
                    writeScope: this.state.writeScope,
                    llm: ({ messages, onDelta }) =>
                        this.streamChat({
                            provider: this.state.provider,
                            model: this.state.model,
                            messages,
                            onStatus: (s) => (statusEl.textContent = s),
                            onDelta
                        }),
                    onLog: appendLog,
                    onPlan: (plan) => {
                        appendLog(`\n[PLAN]\n${JSON.stringify(plan, null, 2)}\n`, 'plan');
                    },
                    onApprove: async ({ tool, args }) => {
                        const summary = `${tool} ${JSON.stringify(args || {})}`;
                        return window.confirm(`Run tool?\n\n${summary}`);
                    },
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
                    const srcdoc = this.buildPreviewSrcdoc(htmlRes.data);
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
                            const srcdoc = this.buildPreviewSrcdoc(htmlAlt.data);
                            frameEl.srcdoc = srcdoc;
                            appendLog(`\n[WARN] index.html not found at root. Previewing ${fallback}\n`, 'warn');
                        } else {
                            frameEl.srcdoc = `<div style=\"padding:12px;color:#999;font-family:monospace;\">No previewable index.html found in ${projectRoot}.</div>`;
                        }
                    } else {
                        frameEl.srcdoc = `<div style=\"padding:12px;color:#999;font-family:monospace;\">No previewable index.html found in ${projectRoot}.</div>`;
                    }
                }

                const summaryText = finalSummary && (finalSummary.summary || finalSummary.message);
                if (summaryText) {
                    statusEl.textContent = 'Completed';
                    appendLog(`\n[SUMMARY]\n${summaryText}\n`, 'summary');
                    if (finalSummary.questions && Array.isArray(finalSummary.questions)) {
                        appendLog(`\n[QUESTIONS]\n${finalSummary.questions.join('\n')}\n`, 'summary');
                    }
                    if (finalSummary.suggested_tools && Array.isArray(finalSummary.suggested_tools)) {
                        appendLog(`\n[SUGGESTED TOOLS]\n${JSON.stringify(finalSummary.suggested_tools, null, 2)}\n`, 'summary');
                    }
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

        promptEl.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            if (e.shiftKey) return;
            e.preventDefault();
            genBtn.click();
        });
    }
}
