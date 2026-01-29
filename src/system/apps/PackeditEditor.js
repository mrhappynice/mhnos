import * as fs from '../../kernel/fs.js';
import { isLikelyTextPath } from './helpers.js';

// --- APP: PACKEDIT EDITOR ---
export class PackeditEditor {
    constructor(os) {
        this.os = os;
        this.bridge = null;
    }

    async open(projectRoot = '/apps') {
        const container = document.createElement('div');
        container.style.cssText = 'display:flex; flex-direction:column; height:100%; background:#151515; color:#e5e5e5; font-family:system-ui, sans-serif;';

        const pickerWrap = document.createElement('div');
        pickerWrap.style.cssText = 'display:flex; flex-direction:column; height:100%; background:#131314; color:#e5e5e5;';

        const editorRoot = document.createElement('div');
        editorRoot.style.cssText = 'display:none; flex-direction:column; height:100%;';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex; gap:8px; align-items:center; padding:8px; border-bottom:1px solid #2a2a2a;';

        const pathInput = document.createElement('input');
        pathInput.value = projectRoot;
        pathInput.placeholder = '/apps/my-project';
        pathInput.style.cssText = 'flex:1; background:#0f0f0f; color:#e5e5e5; border:1px solid #333; padding:6px 8px; border-radius:4px;';

        const backBtn = document.createElement('button');
        backBtn.textContent = 'Projects';

        const loadBtn = document.createElement('button');
        loadBtn.textContent = 'Load';

        const buildBtn = document.createElement('button');
        buildBtn.textContent = 'Build';

        const serveBtn = document.createElement('button');
        serveBtn.textContent = 'Serve';

        const zipBtn = document.createElement('button');
        zipBtn.textContent = 'Zip dist';

        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';

        const status = document.createElement('div');
        status.style.cssText = 'margin-left:auto; font-size:12px; color:#9aa0a6;';
        status.textContent = 'Idle';

        header.append(backBtn, pathInput, loadBtn, buildBtn, serveBtn, zipBtn, saveBtn, status);

        const body = document.createElement('div');
        body.style.cssText = 'display:grid; grid-template-columns: 240px 1fr 1fr; flex:1; min-height:0;';

        const filePanel = document.createElement('div');
        filePanel.style.cssText = 'display:flex; flex-direction:column; border-right:1px solid #2a2a2a; background:#101010; min-height:0;';

        const fileList = document.createElement('div');
        fileList.style.cssText = 'flex:1; overflow:auto; padding:8px;';

        const fileActions = document.createElement('div');
        fileActions.style.cssText = 'display:flex; gap:6px; padding:8px; border-top:1px solid #2a2a2a; background:#0f0f0f;';

        const addFileBtn = document.createElement('button');
        addFileBtn.textContent = '+ File';

        const addDirBtn = document.createElement('button');
        addDirBtn.textContent = '+ Dir';

        fileActions.append(addFileBtn, addDirBtn);
        filePanel.append(fileList, fileActions);

        const editorWrap = document.createElement('div');
        editorWrap.style.cssText = 'display:flex; flex-direction:column; border-right:1px solid #2a2a2a; background:#111;';

        const editor = document.createElement('textarea');
        editor.spellcheck = false;
        editor.style.cssText = 'flex:1; width:100%; padding:12px; border:none; outline:none; resize:none; font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace; font-size:13px; color:#f1f1f1; background:#111;';

        editorWrap.appendChild(editor);

        const previewWrap = document.createElement('div');
        previewWrap.style.cssText = 'background:#fff;';

        const preview = document.createElement('iframe');
        preview.style.cssText = 'width:100%; height:100%; border:0; background:#fff;';
        preview.setAttribute('sandbox', 'allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts allow-downloads allow-pointer-lock');
        preview.src = '/packedit/os-bundler/index.html';

        previewWrap.appendChild(preview);

        body.append(filePanel, editorWrap, previewWrap);
        editorRoot.append(header, body);
        container.append(pickerWrap, editorRoot);

        const win = this.os.wm.createWindow('Packedit', container, { width: 1200, height: 720 });

        const state = {
            projectRoot,
            activePath: null,
            files: new Map(),
            meta: new Map(),
            browsePath: '/apps',
            selectedFolder: '',
            activeDir: ''
        };

        const setStatus = (text) => {
            status.textContent = text;
        };

        const normalizePath = (path) => {
            const parts = String(path || '').split('/').filter(Boolean);
            const stack = [];
            for (const part of parts) {
                if (part === '.') continue;
                if (part === '..') stack.pop();
                else stack.push(part);
            }
            return '/' + stack.join('/');
        };

        const showPicker = () => {
            editorRoot.style.display = 'none';
            pickerWrap.style.display = 'flex';
        };

        const showEditor = () => {
            pickerWrap.style.display = 'none';
            editorRoot.style.display = 'flex';
        };

        const isTextFile = (path) => isLikelyTextPath(path);

        const listFilesRecursive = async (base, out = []) => {
            const res = await fs.listFiles(base);
            if (!res || !res.success) return out;
            for (const entry of res.data || []) {
                const fullPath = normalizePath(`${base}/${entry.name}`);
                if (entry.type === 'directory') {
                    if (['node_modules', 'dist', '.git', '.cache'].includes(entry.name)) continue;
                    await listFilesRecursive(fullPath, out);
                } else if (isTextFile(fullPath)) {
                    out.push(fullPath);
                }
            }
            return out;
        };

        const listEntriesRecursive = async (base, depth = 0, out = []) => {
            const res = await fs.listFiles(base);
            if (!res || !res.success) return out;
            const dirs = (res.data || []).filter(entry => entry.type === 'directory');
            const files = (res.data || []).filter(entry => entry.type === 'file');

            for (const entry of dirs) {
                if (['node_modules', 'dist', '.git', '.cache'].includes(entry.name)) continue;
                const fullPath = normalizePath(`${base}/${entry.name}`);
                out.push({ path: fullPath, type: 'directory', depth, name: entry.name });
                await listEntriesRecursive(fullPath, depth + 1, out);
            }

            for (const entry of files) {
                const fullPath = normalizePath(`${base}/${entry.name}`);
                if (!isTextFile(fullPath)) continue;
                out.push({ path: fullPath, type: 'file', depth, name: entry.name });
            }

            return out;
        };

        const getVirtualPath = (absPath) => {
            const root = normalizePath(state.projectRoot || '/');
            let rel = absPath;
            if (root !== '/' && absPath.startsWith(root)) {
                rel = absPath.slice(root.length);
            }
            return normalizePath('/' + rel.replace(/^\/+/, ''));
        };

        const refreshEntries = async () => {
            const root = normalizePath(state.projectRoot || '/');
            const rootName = root === '/' ? '/' : root.split('/').filter(Boolean).pop();
            const out = [{ path: root, type: 'directory', depth: 0, name: rootName }];
            await listEntriesRecursive(root, 1, out);
            state.entries = out;
        };

        const renderFileList = () => {
            fileList.innerHTML = '';
            const entries = (state.entries || []).slice();
            for (const entry of entries) {
                const row = document.createElement('div');
                const icon = entry.type === 'directory' ? '📁' : '📄';
                row.textContent = `${icon} ${entry.name}`;
                row.style.cssText = 'padding:4px 6px; cursor:pointer; border-radius:4px; font-size:12px; color:#d1d5db;';
                row.style.paddingLeft = `${8 + entry.depth * 12}px`;

                if (entry.type === 'directory' && entry.path === state.activeDir) {
                    row.style.background = '#1f2937';
                }

                if (entry.type === 'file') {
                    const virtualPath = getVirtualPath(entry.path);
                    if (virtualPath === state.activePath) {
                        row.style.background = '#1e3a8a';
                    }
                    row.onclick = () => openFile(virtualPath);
                } else {
                    row.onclick = () => {
                        state.activeDir = entry.path;
                        renderFileList();
                    };
                }
                fileList.appendChild(row);
            }
        };

        const openFile = (path) => {
            if (!state.files.has(path)) return;
            state.activePath = path;
            editor.value = state.files.get(path) || '';
            renderFileList();
        };

        const updatePreview = (() => {
            let timer = null;
            return () => {
                if (!this.bridge) return;
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => {
                    const modules = {};
                    const root = normalizePath(state.projectRoot || '/');
                    state.files.forEach((code, path) => {
                        modules[path] = { code, path };
                        if (root !== '/' && !path.startsWith(root + '/')) {
                            const aliased = normalizePath(`${root}/${path}`);
                            if (!modules[aliased]) {
                                modules[aliased] = { code, path: aliased };
                            }
                        }
                    });
                    this.bridge.compile(modules);
                }, 250);
            };
        })();

        const loadProject = async (rootPath) => {
            const rootResolved = normalizePath(rootPath || '/apps');
            const statRes = await fs.stat(rootResolved);
            if (!statRes || !statRes.success || !statRes.data?.isDir) {
                setStatus(`Not a folder: ${rootResolved}`);
                return;
            }
            setStatus('Loading files...');
            state.projectRoot = rootResolved;
            state.activeDir = rootResolved;
            state.files.clear();
            state.meta.clear();

            const filePaths = await listFilesRecursive(rootResolved);
            for (const absPath of filePaths) {
                const res = await fs.readFile(absPath, true);
                if (!res || !res.success) continue;
                const rel = absPath.startsWith(rootResolved) ? absPath.slice(rootResolved.length) : absPath;
                const virtualPath = normalizePath('/' + rel.replace(/^\/+/, ''));
                state.files.set(virtualPath, res.data || '');
                state.meta.set(virtualPath, { absPath });
            }

            if (!state.files.size) {
                setStatus('No files found.');
                return;
            }

            const firstFile = Array.from(state.files.keys()).sort()[0];
            openFile(firstFile);
            await refreshEntries();
            renderFileList();
            setStatus('Loaded');
            updatePreview();
            showEditor();
        };

        class PackeditBridge {
            constructor(iframe, onStatus) {
                this.iframe = iframe;
                this.channelId = null;
                this.ready = false;
                this.origin = '*';
                this.onStatus = onStatus;
                this.pendingModules = null;
                this.handleMessage = this.handleMessage.bind(this);
                window.addEventListener('message', this.handleMessage);
            }

            handleMessage(event) {
                if (event.source !== this.iframe.contentWindow) return;
                const msg = event.data || {};
                if (!msg.codesandbox) return;
                if (msg.type === 'initialized') {
                    this.channelId = Math.floor(Math.random() * 1e6);
                    this.origin = event.origin || '*';
                    this.iframe.contentWindow.postMessage({
                        type: 'register-frame',
                        origin: window.location.origin,
                        id: this.channelId
                    }, this.origin);
                    this.ready = true;
                    this.onStatus('Bundler ready');
                    if (this.pendingModules) {
                        this.compile(this.pendingModules);
                        this.pendingModules = null;
                    }
                    return;
                }
                if (this.channelId !== null && msg.$id !== this.channelId) return;
                if (msg.type === 'start') this.onStatus('Building...');
                if (msg.type === 'done') this.onStatus(msg.compilatonError ? 'Build error' : 'Preview ready');
                if (msg.type === 'action' && msg.action === 'show-error') {
                    this.onStatus(`Error: ${msg.message || msg.title || 'Build failed'}`);
                }
            }

            compile(modules) {
                if (!this.ready || this.channelId === null) {
                    this.pendingModules = modules;
                    return;
                }
                this.iframe.contentWindow.postMessage({
                    $id: this.channelId,
                    codesandbox: true,
                    type: 'compile',
                    version: 3,
                    modules,
                    externalResources: [],
                    showOpenInCodeSandbox: false,
                    showErrorScreen: true,
                    showLoadingScreen: false,
                    skipEval: false,
                    clearConsoleDisabled: true
                }, this.origin);
            }

            destroy() {
                window.removeEventListener('message', this.handleMessage);
            }
        }

        this.bridge = new PackeditBridge(preview, setStatus);

        const runWithCwd = async (cwd, command) => {
            const shell = this.os.shell;
            const prev = shell.cwd;
            shell.cwd = cwd;
            await shell.execute(command);
            shell.cwd = prev;
        };

        backBtn.onclick = () => showPicker();
        loadBtn.onclick = () => loadProject(pathInput.value.trim() || '/apps');
        buildBtn.onclick = async () => {
            if (!state.projectRoot) return;
            await runWithCwd(state.projectRoot, `oapp build ${state.projectRoot}`);
        };
        serveBtn.onclick = async () => {
            if (!state.projectRoot) return;
            const distRoot = normalizePath(`${state.projectRoot}/dist`);
            await runWithCwd(distRoot, 'serverhere');
            await runWithCwd(distRoot, 'run server.js');
            await runWithCwd(distRoot, 'browser');
        };
        zipBtn.onclick = async () => {
            if (!state.projectRoot) return;
            const distRoot = normalizePath(`${state.projectRoot}/dist`);
            await runWithCwd(state.projectRoot, `backup local export ${distRoot}`);
        };
        saveBtn.onclick = async () => {
            if (!state.activePath) return;
            const meta = state.meta.get(state.activePath);
            if (!meta || !meta.absPath) return;
            await fs.writeFile(meta.absPath, editor.value);
            state.files.set(state.activePath, editor.value);
            setStatus(`Saved ${state.activePath}`);
            updatePreview();
        };

        editor.addEventListener('input', () => {
            if (!state.activePath) return;
            state.files.set(state.activePath, editor.value);
            updatePreview();
        });

        const promptForPath = (label) => {
            const input = prompt(label || 'Enter path');
            if (!input) return null;
            return input.trim();
        };

        addFileBtn.onclick = async () => {
            if (!state.projectRoot) return;
            const input = promptForPath('New file path (relative to selected folder)');
            if (!input) return;
            const base = state.activeDir || state.projectRoot;
            const absPath = input.startsWith('/') ? normalizePath(input) : normalizePath(`${base}/${input}`);
            const writeRes = await fs.writeFile(absPath, '');
            if (!writeRes || !writeRes.success) {
                setStatus(`Failed to create ${absPath}`);
                return;
            }
            const virtualPath = getVirtualPath(absPath);
            state.files.set(virtualPath, '');
            state.meta.set(virtualPath, { absPath });
            await refreshEntries();
            openFile(virtualPath);
            setStatus(`Created ${virtualPath}`);
            updatePreview();
        };

        addDirBtn.onclick = async () => {
            if (!state.projectRoot) return;
            const input = promptForPath('New folder path (relative to selected folder)');
            if (!input) return;
            const base = state.activeDir || state.projectRoot;
            const absPath = input.startsWith('/') ? normalizePath(input) : normalizePath(`${base}/${input}`);
            const res = await fs.createDir(absPath);
            if (!res || !res.success) {
                setStatus(`Failed to create ${absPath}`);
                return;
            }
            state.activeDir = absPath;
            await refreshEntries();
            renderFileList();
            setStatus(`Created ${absPath}`);
        };

        win.addEventListener('window:close', () => {
            if (this.bridge) this.bridge.destroy();
        });

        // --- Project Picker UI ---
        const pickerHeader = document.createElement('div');
        pickerHeader.style.cssText = 'display:flex; align-items:center; gap:12px; padding:16px; border-bottom:1px solid #9aa0a6;';

        const pickerTitle = document.createElement('div');
        pickerTitle.textContent = 'Choose a project';
        pickerTitle.style.cssText = 'font-weight:800; font-size:20px; letter-spacing:0.4px;';

        const pickerPathInput = document.createElement('input');
        pickerPathInput.value = state.browsePath;
        pickerPathInput.placeholder = '/apps';
        pickerPathInput.style.cssText = 'flex:1; background:#0f0f0f; color:#e5e5e5; border:1px solid #9aa0a6; padding:10px 12px; border-radius:6px; font-size:14px;';

        const browseBtn = document.createElement('button');
        browseBtn.textContent = 'Browse';
        browseBtn.style.cssText = 'padding:10px 14px; border:1px solid #9aa0a6; background:#1a1a1b; color:#e5e5e5; border-radius:6px; font-weight:600;';

        pickerHeader.append(pickerTitle, pickerPathInput, browseBtn);

        const pickerBody = document.createElement('div');
        pickerBody.style.cssText = 'display:grid; grid-template-columns: 1fr 1fr; gap:20px; padding:16px; flex:1; min-height:0;';

        const folderListWrap = document.createElement('div');
        folderListWrap.style.cssText = 'border:1px solid #9aa0a6; border-radius:10px; overflow:auto; min-height:0; background:#0f0f10;';

        const folderList = document.createElement('div');
        folderList.style.cssText = 'padding:12px;';

        folderListWrap.appendChild(folderList);

        const actionsWrap = document.createElement('div');
        actionsWrap.style.cssText = 'display:flex; flex-direction:column; gap:16px;';

        const selectedLabel = document.createElement('div');
        selectedLabel.style.cssText = 'font-size:13px; color:#9aa0a6; letter-spacing:0.2px;';
        selectedLabel.textContent = 'Selected: (none)';

        const loadSelectedBtn = document.createElement('button');
        loadSelectedBtn.textContent = 'Load selected folder';
        loadSelectedBtn.style.cssText = 'padding:12px 14px; border:1px solid #9aa0a6; background:#1f1f20; color:#e5e5e5; border-radius:8px; font-weight:700; font-size:14px;';

        const manualWrap = document.createElement('div');
        manualWrap.style.cssText = 'display:flex; flex-direction:column; gap:8px; border:1px solid #9aa0a6; padding:12px; border-radius:10px; background:#0f0f10;';

        const manualLabel = document.createElement('div');
        manualLabel.textContent = 'Load by path';
        manualLabel.style.cssText = 'font-weight:700; font-size:16px;';

        const manualInput = document.createElement('input');
        manualInput.placeholder = '/apps/my-project';
        manualInput.style.cssText = 'background:#0f0f0f; color:#e5e5e5; border:1px solid #9aa0a6; padding:10px 12px; border-radius:6px; font-size:14px;';

        const manualLoadBtn = document.createElement('button');
        manualLoadBtn.textContent = 'Load';
        manualLoadBtn.style.cssText = 'padding:12px 14px; border:1px solid #9aa0a6; background:#1f1f20; color:#e5e5e5; border-radius:8px; font-weight:700; font-size:14px;';

        manualWrap.append(manualLabel, manualInput, manualLoadBtn);

        const createWrap = document.createElement('div');
        createWrap.style.cssText = 'display:flex; flex-direction:column; gap:8px; border:1px solid #9aa0a6; padding:12px; border-radius:10px; background:#0f0f10;';

        const createLabel = document.createElement('div');
        createLabel.textContent = 'Create a project';
        createLabel.style.cssText = 'font-weight:700; font-size:16px;';

        const createInput = document.createElement('input');
        createInput.placeholder = '/apps/new-project';
        createInput.style.cssText = 'background:#0f0f0f; color:#e5e5e5; border:1px solid #9aa0a6; padding:10px 12px; border-radius:6px; font-size:14px;';

        const createBtn = document.createElement('button');
        createBtn.textContent = 'Create React app (oapp init)';
        createBtn.style.cssText = 'padding:12px 14px; border:1px solid #9aa0a6; background:#1f1f20; color:#e5e5e5; border-radius:8px; font-weight:700; font-size:14px;';

        createWrap.append(createLabel, createInput, createBtn);

        actionsWrap.append(selectedLabel, loadSelectedBtn, manualWrap, createWrap);
        pickerBody.append(folderListWrap, actionsWrap);
        pickerWrap.append(pickerHeader, pickerBody);

        const renderFolderList = async (rootPath) => {
            const target = normalizePath(rootPath || '/apps');
            state.browsePath = target;
            pickerPathInput.value = target;
            folderList.innerHTML = '';
            state.selectedFolder = '';
            selectedLabel.textContent = 'Selected: (none)';

            const res = await fs.listFiles(target);
            if (!res || !res.success) {
                const err = document.createElement('div');
                err.textContent = `Unable to list ${target}`;
                err.style.cssText = 'color:#f87171; padding:6px;';
                folderList.appendChild(err);
                return;
            }

            const up = document.createElement('div');
            up.textContent = '..';
            up.style.cssText = 'padding:8px; cursor:pointer; border-radius:6px; color:#9aa0a6; font-weight:600;';
            up.onclick = () => {
                const parent = normalizePath(target.split('/').slice(0, -1).join('/') || '/');
                renderFolderList(parent);
            };
            folderList.appendChild(up);

            const dirs = (res.data || []).filter(item => item.type === 'directory');
            if (dirs.length === 0) {
                const empty = document.createElement('div');
                empty.textContent = '(no folders)';
                empty.style.cssText = 'padding:6px; color:#9aa0a6;';
                folderList.appendChild(empty);
                return;
            }

            for (const entry of dirs) {
                const row = document.createElement('div');
                row.textContent = entry.name + '/';
                row.style.cssText = 'padding:8px; cursor:pointer; border-radius:6px; font-weight:600;';
                row.onclick = () => {
                    state.selectedFolder = normalizePath(`${target}/${entry.name}`);
                    selectedLabel.textContent = `Selected: ${state.selectedFolder}`;
                    [...folderList.children].forEach(c => (c.style.background = ''));
                    row.style.background = '#1f2937';
                };
                row.ondblclick = () => renderFolderList(normalizePath(`${target}/${entry.name}`));
                folderList.appendChild(row);
            }
        };

        browseBtn.onclick = () => renderFolderList(pickerPathInput.value.trim() || '/apps');
        loadSelectedBtn.onclick = () => {
            if (!state.selectedFolder) return;
            pathInput.value = state.selectedFolder;
            loadProject(state.selectedFolder);
        };
        manualLoadBtn.onclick = () => {
            const val = manualInput.value.trim();
            if (!val) return;
            pathInput.value = val;
            loadProject(val);
        };
        createBtn.onclick = async () => {
            const val = createInput.value.trim();
            if (!val) return;
            await runWithCwd('/', `oapp init ${val}`);
            pathInput.value = val;
            loadProject(val);
        };

        renderFolderList(state.browsePath);
        showPicker();
    }
}
