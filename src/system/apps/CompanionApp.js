import * as fs from '../../kernel/fs.js';
import { buildSnippet, isLikelyTextPath, readTextFileSafe } from './helpers.js';
import { runCodingAgentFlow } from '../appBuilderFlow.js';

const SYSTEM_CONTEXT_PATH = '/system/agent_context.md';

// --- APP: COMPANION ---
export class CompanionApp {
    constructor(os) {
        this.os = os;
        this.state = this.loadState();
    }

    loadState() {
        const provider = localStorage.getItem('comp_provider') || 'lmstudio';
        const model = localStorage.getItem('comp_model') || '';
        const baseURL =
            localStorage.getItem('comp_baseURL') ||
            (provider === 'openai'
                ? 'https://api.openai.com'
                : provider === 'openrouter'
                ? 'https://openrouter.ai/api'
                : provider === 'llamacpp'
                ? 'http://localhost:8080'
                : 'http://localhost:1234');

        const systemPrompt =
            localStorage.getItem('comp_systemPrompt') ||
            `You are the MHNOS Companion.\n` +
            `Help users understand how the OS works (OPFS, shell, oapp, Packedit, Python, npm).\n` +
            `Prefer read/search before write. Keep edits small and explain them.\n` +
            `Do not ask for confirmation; proceed with tool calls when needed.`;

        const workingRoot = localStorage.getItem('comp_workingRoot') || '/';
        const useSystemContext = localStorage.getItem('comp_useSystemContext') !== 'false';
        const writeScope = localStorage.getItem('comp_writeScope') || 'opfs';
        return { provider, model, baseURL, systemPrompt, workingRoot, useSystemContext, writeScope };
    }

    saveState() {
        localStorage.setItem('comp_provider', this.state.provider);
        localStorage.setItem('comp_model', this.state.model);
        localStorage.setItem('comp_baseURL', this.state.baseURL);
        localStorage.setItem('comp_systemPrompt', this.state.systemPrompt);
        localStorage.setItem('comp_workingRoot', this.state.workingRoot || '/');
        localStorage.setItem('comp_useSystemContext', this.state.useSystemContext ? 'true' : 'false');
        localStorage.setItem('comp_writeScope', this.state.writeScope || 'opfs');
    }

    getApiKey(provider) {
        return localStorage.getItem('api_key_' + provider) || '';
    }

    setApiKey(provider, key) {
        if (!key) localStorage.removeItem('api_key_' + provider);
        else localStorage.setItem('api_key_' + provider, key);
    }

    providerConfig(provider) {
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
            return {
                modelsURL: `${this.state.baseURL}/v1/models`,
                chatURL: `${this.state.baseURL}/v1/chat/completions`,
                needsKey: false
            };
        }
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

        if (provider === 'openai' || provider === 'openrouter') {
            const key = this.getApiKey(provider);
            if (key) headers['Authorization'] = `Bearer ${key}`;
            if (provider === 'openrouter') {
                headers['HTTP-Referer'] = window.location.origin;
                headers['X-Title'] = 'MHN OS Companion';
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

            if (this.state.model && list.some(m => m.id === this.state.model)) {
                modelSelect.value = this.state.model;
            } else {
                this.state.model = modelSelect.value;
                this.saveState();
            }

            statusEl.textContent = `Models loaded (${list.length})`;
        } catch (e) {
            console.warn('[Companion] fetchModels failed', e);
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
            headers['HTTP-Referer'] = window.location.origin;
            headers['X-Title'] = 'MHN OS Companion';
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
                } catch {}
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
            } catch {}
        }
    }

    async open() {
        const div = document.createElement('div');
        div.className = 'comp-root';
        div.style.cssText =
            'display:flex; flex-direction:column; height:100%; padding:10px; gap:10px; background:#141414; color:#e6e6e6;';

        div.innerHTML = `
  <div class="comp-header">
    <div class="comp-title">
      <div class="comp-title-main">Companion</div>
      <div class="comp-title-sub">Guide + helper for MHNOS</div>
    </div>
    <div class="comp-actions">
      <button class="comp-new-chat">New Chat</button>
      <button class="comp-open-launcher">Open Launcher.json</button>
      <button class="comp-open-packedit">Open Packedit</button>
    </div>
  </div>

  <details class="comp-panel comp-llm" open>
    <summary class="comp-summary">Settings</summary>

    <div class="comp-grid">
      <label class="comp-field">
        <span>Provider</span>
        <select class="comp-provider">
          <option value="lmstudio">LM Studio (localhost:1234)</option>
          <option value="llamacpp">llama.cpp server (localhost:8080)</option>
          <option value="openai">OpenAI</option>
          <option value="openrouter">OpenRouter</option>
        </select>
      </label>

      <label class="comp-field">
        <span>Base URL</span>
        <input class="comp-baseurl" placeholder="http://localhost:1234" />
      </label>

      <label class="comp-field">
        <span>Model</span>
        <select class="comp-model"><option>Loading...</option></select>
      </label>

      <label class="comp-field">
        <span>API Key</span>
        <input class="comp-key" type="password" placeholder="sk-..." />
      </label>

      <label class="comp-field comp-wide">
        <span>System Prompt</span>
        <textarea class="comp-sys" rows="4"></textarea>
      </label>

      <label class="comp-field comp-wide">
        <span>Working root</span>
        <input class="comp-root-input" placeholder="/" />
      </label>

      <label class="comp-field comp-wide">
        <span>Companion Mode</span>
        <div style="display:flex; gap:12px; align-items:center;">
          <label style="display:flex; gap:6px; align-items:center;">
            <input type="checkbox" class="comp-context-toggle" />
            <span>Use ${SYSTEM_CONTEXT_PATH}</span>
          </label>
        </div>
      </label>

      <label class="comp-field comp-wide">
        <span>Tool Behavior</span>
        <div style="display:flex; gap:14px; align-items:center;">
          <label style="display:flex; gap:6px; align-items:center;">
            <span>Write scope</span>
            <select class="comp-write-scope">
              <option value="opfs">Any OPFS path</option>
              <option value="project">Working root only</option>
            </select>
          </label>
        </div>
      </label>
    </div>
  </details>

  <div class="comp-row">
    <div class="comp-status">Idle</div>
  </div>

  <div class="comp-main">
    <section class="comp-pane comp-chat-pane">
      <div class="comp-pane-head">Chat</div>
      <div class="comp-chat-log"></div>
      <div class="comp-chat-input">
        <textarea class="comp-prompt" placeholder="Ask about MHNOS or request a change..."></textarea>
        <button class="comp-send comp-primary">Send</button>
      </div>
    </section>

    <aside class="comp-side">
      <div class="comp-side-head">
        <div>Search OPFS</div>
        <button class="comp-reindex">Reindex</button>
      </div>
      <div class="comp-search">
        <input class="comp-search-input" placeholder="Search files..." />
        <div class="comp-search-status">Indexing...</div>
      </div>
      <div class="comp-search-results"></div>
      <div class="comp-context">
        <div class="comp-context-head">
          <div>Selected context</div>
          <div class="comp-context-actions">
            <button class="comp-add-context">Add Selected</button>
            <button class="comp-clear-context">Clear</button>
          </div>
        </div>
        <div class="comp-context-list"></div>
      </div>
    </aside>
  </div>
`;

        this.os.wm.createWindow('Companion', div, { width: 900, height: 720 });

        const providerEl = div.querySelector('.comp-provider');
        const baseUrlEl = div.querySelector('.comp-baseurl');
        const modelEl = div.querySelector('.comp-model');
        const keyEl = div.querySelector('.comp-key');
        const sysEl = div.querySelector('.comp-sys');
        const rootEl = div.querySelector('.comp-root-input');
        const contextToggleEl = div.querySelector('.comp-context-toggle');
        const writeScopeEl = div.querySelector('.comp-write-scope');
        const statusEl = div.querySelector('.comp-status');
        const chatLogEl = div.querySelector('.comp-chat-log');
        const promptEl = div.querySelector('.comp-prompt');
        const sendBtn = div.querySelector('.comp-send');
        const newChatBtn = div.querySelector('.comp-new-chat');
        const openLauncherBtn = div.querySelector('.comp-open-launcher');
        const openPackeditBtn = div.querySelector('.comp-open-packedit');
        const searchInput = div.querySelector('.comp-search-input');
        const searchStatus = div.querySelector('.comp-search-status');
        const searchResults = div.querySelector('.comp-search-results');
        const reindexBtn = div.querySelector('.comp-reindex');
        const addContextBtn = div.querySelector('.comp-add-context');
        const clearContextBtn = div.querySelector('.comp-clear-context');
        const contextList = div.querySelector('.comp-context-list');

        let streamEl = null;
        let searchIndex = null;
        let indexPromise = null;
        const selectedSearchPaths = new Set();
        const contextPaths = new Set();

        const addMessage = (role, text) => {
            const el = document.createElement('div');
            el.className = `comp-msg comp-msg-${role}`;
            el.textContent = text || '';
            if (role === 'assistant') {
                const copyBtn = document.createElement('button');
                copyBtn.className = 'comp-copy';
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

        const appendStream = (chunk) => {
            if (!streamEl) streamEl = addMessage('assistant', '');
            streamEl.textContent += chunk;
            chatLogEl.scrollTop = chatLogEl.scrollHeight;
        };

        const syncKeyField = () => {
            const p = providerEl.value;
            const needsKey = p === 'openai' || p === 'openrouter';
            keyEl.disabled = !needsKey;
            keyEl.placeholder = needsKey ? 'sk-...' : '(not required)';
            keyEl.value = this.getApiKey(p) || '';
        };

        const refreshModels = async () => {
            this.state.provider = providerEl.value;
            this.state.baseURL = baseUrlEl.value.trim() || this.state.baseURL;
            syncKeyField();
            this.saveState();
            await this.fetchModels(this.state.provider, modelEl, statusEl);
        };

        // Init UI state
        providerEl.value = this.state.provider;
        baseUrlEl.value = this.state.baseURL;
        sysEl.value = this.state.systemPrompt;
        keyEl.value = this.getApiKey(this.state.provider) || '';
        rootEl.value = this.state.workingRoot || '/';
        contextToggleEl.checked = !!this.state.useSystemContext;
        writeScopeEl.value = this.state.writeScope || 'opfs';

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

        sysEl.addEventListener('change', () => {
            this.state.systemPrompt = sysEl.value;
            this.saveState();
        });

        rootEl.addEventListener('change', () => {
            this.state.workingRoot = (rootEl.value || '/').trim() || '/';
            this.saveState();
        });

        contextToggleEl.addEventListener('change', () => {
            this.state.useSystemContext = !!contextToggleEl.checked;
            this.saveState();
        });

        writeScopeEl.addEventListener('change', () => {
            this.state.writeScope = writeScopeEl.value || 'opfs';
            this.saveState();
        });

        const clearChat = () => {
            chatLogEl.innerHTML = '';
            streamEl = null;
            statusEl.textContent = 'Idle';
        };

        newChatBtn.onclick = () => {
            clearChat();
        };

        openLauncherBtn.onclick = () => {
            this.os.shell.execute('md /system/launcher.json');
        };

        openPackeditBtn.onclick = () => {
            this.os.shell.execute('packedit');
        };

        await refreshModels();

        const buildSearchIndex = async () => {
            if (searchIndex) {
                searchStatus.textContent = `Indexed ${searchIndex.length} file(s)`;
                return searchIndex;
            }
            if (indexPromise) return indexPromise;

            searchStatus.textContent = 'Indexing...';
            indexPromise = (async () => {
                let tree = [];
                try {
                    tree = await fs.getFullTree();
                } catch (e) {
                    searchStatus.textContent = `Indexing disabled: ${e.message}`;
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
                    } catch {}
                    processed += 1;
                    if (processed % 15 === 0) {
                        searchStatus.textContent = `Indexing... (${processed})`;
                        await new Promise(r => setTimeout(r, 0));
                    }
                }

                searchIndex = index;
                searchStatus.textContent = `Indexed ${index.length} file(s)`;
                return index;
            })();

            return indexPromise;
        };

        const renderContextList = () => {
            contextList.innerHTML = '';
            if (!contextPaths.size) {
                const empty = document.createElement('div');
                empty.className = 'comp-context-empty';
                empty.textContent = 'No files selected.';
                contextList.appendChild(empty);
                return;
            }
            for (const path of contextPaths) {
                const row = document.createElement('div');
                row.className = 'comp-context-item';
                row.textContent = path;
                contextList.appendChild(row);
            }
        };

        const runSearch = async (query) => {
            const q = String(query || '').trim().toLowerCase();
            if (!q) {
                searchResults.innerHTML = '';
                return;
            }
            const index = await buildSearchIndex();
            const hits = [];
            for (const item of index) {
                if (item.pathLower.includes(q) || item.textLower.includes(q)) {
                    const snippet = buildSnippet(item.text, q, 140);
                    hits.push({ path: item.path, snippet });
                }
                if (hits.length >= 80) break;
            }

            searchResults.innerHTML = '';
            if (!hits.length) {
                const empty = document.createElement('div');
                empty.className = 'comp-search-empty';
                empty.textContent = 'No matches.';
                searchResults.appendChild(empty);
                return;
            }

            for (const hit of hits) {
                const row = document.createElement('label');
                row.className = 'comp-search-row';
                const checked = selectedSearchPaths.has(hit.path);
                row.innerHTML = `
                  <input type="checkbox" ${checked ? 'checked' : ''} />
                  <div class="comp-search-meta">
                    <div class="comp-search-path">${hit.path}</div>
                    <div class="comp-search-snippet">${hit.snippet}</div>
                  </div>
                `;
                const checkbox = row.querySelector('input');
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) selectedSearchPaths.add(hit.path);
                    else selectedSearchPaths.delete(hit.path);
                });
                searchResults.appendChild(row);
            }
        };

        searchInput.addEventListener('input', () => runSearch(searchInput.value));
        reindexBtn.addEventListener('click', () => {
            searchIndex = null;
            indexPromise = null;
            selectedSearchPaths.clear();
            searchResults.innerHTML = '';
            buildSearchIndex();
        });

        addContextBtn.addEventListener('click', () => {
            selectedSearchPaths.forEach((path) => contextPaths.add(path));
            selectedSearchPaths.clear();
            Array.from(searchResults.querySelectorAll('input[type="checkbox"]')).forEach((box) => {
                box.checked = false;
            });
            renderContextList();
        });

        clearContextBtn.addEventListener('click', () => {
            contextPaths.clear();
            renderContextList();
        });

        renderContextList();
        buildSearchIndex();

        const resolveWorkingRoot = () => {
            const raw = (rootEl.value || '/').trim() || '/';
            if (!raw.startsWith('/')) return `/${raw}`;
            return raw.replace(/\/+$/, '') || '/';
        };

        const buildFileContext = async () => {
            if (!contextPaths.size) return '';
            const blocks = [];
            for (const path of contextPaths) {
                const res = await fs.readFile(path, true);
                if (!res || !res.success) continue;
                const text = String(res.data || '');
                const trimmed = text.length > 6000 ? text.slice(0, 6000) + '\n…(truncated)' : text;
                blocks.push(`File: ${path}\n${trimmed}`);
            }
            return blocks.length ? blocks.join('\n\n') : '';
        };

        const runToolMode = async (userPrompt) => {
            let systemContext = '';
            if (this.state.useSystemContext) {
                const ctxRes = await fs.readFile(SYSTEM_CONTEXT_PATH, true);
                if (ctxRes && ctxRes.success && typeof ctxRes.data === 'string') {
                    systemContext = ctxRes.data;
                }
            }

            const projectRoot = resolveWorkingRoot();

            const effectivePrompt =
                `${this.state.systemPrompt}\n` +
                `Do not ask for confirmation to use tools; proceed with tool calls when needed.`;

            const fileContext = await buildFileContext();
            const combinedPrompt = fileContext
                ? `${userPrompt}\n\n[CONTEXT]\n${fileContext}`
                : userPrompt;

            const { finalSummary } = await runCodingAgentFlow({
                prompt: combinedPrompt,
                fs,
                os: this.os,
                projectRoot,
                systemPrompt: effectivePrompt,
                systemContext,
                strictRoot: false,
                requireApproval: false,
                writeScope: this.state.writeScope,
                verify: false,
                skipPlanning: true,
                llm: ({ messages, onDelta }) =>
                    this.streamChat({
                        provider: this.state.provider,
                        model: this.state.model,
                        messages,
                        onStatus: (s) => (statusEl.textContent = s),
                        onDelta
                    }),
                onLog: (chunk) => appendStream(chunk),
                onPlan: () => {},
                onStatus: (s) => (statusEl.textContent = s),
                maxSteps: 12
            });

            const summaryText = finalSummary && (finalSummary.summary || finalSummary.message);
            if (summaryText) appendStream(`\n[SUMMARY]\n${summaryText}\n`);
            statusEl.textContent = 'Completed';
            contextPaths.clear();
            renderContextList();
        };

        sendBtn.onclick = async () => {
            const userPrompt = (promptEl.value || '').trim();
            if (!userPrompt) {
                statusEl.textContent = 'Enter a prompt.';
                return;
            }

            addMessage('user', userPrompt);
            promptEl.value = '';
            streamEl = null;

            // Persist selections
            this.state.provider = providerEl.value;
            this.state.baseURL = baseUrlEl.value.trim() || this.state.baseURL;
            this.state.model = modelEl.value || this.state.model;
            this.state.systemPrompt = sysEl.value;
            this.state.workingRoot = resolveWorkingRoot();
            this.state.useSystemContext = !!contextToggleEl.checked;
            this.state.writeScope = writeScopeEl.value || 'opfs';
            this.saveState();
            this.setApiKey(this.state.provider, keyEl.value.trim());

            try {
                await runToolMode(userPrompt);
            } catch (e) {
                statusEl.textContent = `Error: ${e.message}`;
                this.os.shell.print(`[Companion] ${e.message}`, 'error');
                console.error(e);
            }
        };

        promptEl.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            if (e.shiftKey) return;
            e.preventDefault();
            sendBtn.click();
        });
    }
}
