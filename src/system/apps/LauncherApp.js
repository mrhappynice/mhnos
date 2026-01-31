import * as fs from '../../kernel/fs.js';
import { buildSnippet, isLikelyTextPath, readTextFileSafe } from './helpers.js';

const LAUNCHER_CONFIG_PATH = '/system/launcher.json';

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
                addIfMissing({ id: 'link', label: 'Tools Menu', type: 'url', url: 'https://tools.mhn.lol', icon: '⚒️' });
                addIfMissing({ id: 'codejournal', label: 'Code Journal', type: 'url', url: 'https://cj.mhn.lol', icon: '📓' });
                addIfMissing({ id: 'companion', label: 'Companion', type: 'app', command: 'companion', icon: '🧭' });
                addIfMissing({ id: 'packedit', label: 'Packedit', type: 'app', command: 'packedit', icon: '🧩' });
                addIfMissing({ id: 'wget-md', label: 'wget-url.md', type: 'markdown', path: '/demos/utils/wget-url.md', icon: '🪃' });
                addIfMissing({ id: 'readme-md', label: 'README', type: 'markdown', path: '/demos/utils/README.md', icon: '📖' });
                const legacy = items.find(entry => entry.id === 'appbuilder');
                if (legacy) {
                    legacy.command = 'companion';
                    legacy.label = legacy.label || 'Companion';
                }
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
                { id: 'codejournal', label: 'Code Journal', type: 'url', url: 'https://cj.mhn.lol', icon: '🗒️' },
                { id: 'companion', label: 'Companion', type: 'app', command: 'companion', icon: '🧭' },
                { id: 'packedit', label: 'Packedit', type: 'app', command: 'packedit', icon: '🧩' },
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
