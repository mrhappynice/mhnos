// src/system/appBuilderFlow.js

function extractJsonBlock(text) {
    const fence = /```json\s*([\s\S]*?)```/i;
    const m = fence.exec(text);
    if (m) {
        try {
            return JSON.parse(m[1]);
        } catch {
            return null;
        }
    }

    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
        const slice = text.slice(first, last + 1);
        const parsed = extractFirstJsonObject(slice);
        if (parsed) return parsed;
        try {
            return JSON.parse(slice);
        } catch {
            return null;
        }
    }
    return null;
}

function extractFirstJsonObject(text) {
    const len = text.length;
    for (let i = 0; i < len; i++) {
        if (text[i] !== '{') continue;
        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let j = i; j < len; j++) {
            const ch = text[j];
            if (inStr) {
                if (esc) {
                    esc = false;
                } else if (ch === '\\\\') {
                    esc = true;
                } else if (ch === '"') {
                    inStr = false;
                }
                continue;
            }
            if (ch === '"') {
                inStr = true;
                continue;
            }
            if (ch === '{') depth++;
            if (ch === '}') {
                depth--;
                if (depth === 0) {
                    const candidate = text.slice(i, j + 1);
                    try {
                        return JSON.parse(candidate);
                    } catch {
                        break;
                    }
                }
            }
        }
    }
    return null;
}

function extractBlocks(text) {
    const blocks = { html: '', css: '', tsx: [] };
    const regex = /```(html|css|tsx)\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(text))) {
        const lang = match[1];
        const body = (match[2] || '').trim();
        if (lang === 'tsx') blocks.tsx.push(body);
        else blocks[lang] = body;
    }
    return blocks;
}

function ensureHtmlReferences(html, cssPath = 'src/styles.css', entryPath = 'src/main.tsx') {
    let out = html || '';

    const hasCss = /<link[^>]*rel=["']stylesheet["'][^>]*href=["'][^"']*styles\.css["'][^>]*>/i.test(out);
    const hasJs = /<script[^>]*type=["']module["'][^>]*src=["'][^"']*main\.tsx["'][^>]*>\s*<\/script>/i.test(out);

    if (!hasCss) {
        if (/<\/head>/i.test(out)) {
            out = out.replace(/<\/head>/i, `<link rel="stylesheet" href="${cssPath}">\n</head>`);
        } else {
            out = `<head>\n<link rel="stylesheet" href="${cssPath}">\n</head>\n` + out;
        }
    }

    if (!hasJs) {
        if (/<\/body>/i.test(out)) {
            out = out.replace(/<\/body>/i, `<script type="module" src="${entryPath}"></script>\n</body>`);
        } else {
            out = out + `\n<script type="module" src="${entryPath}"></script>`;
        }
    }

    return out;
}

export async function runAppBuilderFlow({
    prompt,
    llm,
    fs,
    appDir,
    slug,
    systemPrompt,
    onLog,
    onStatus,
    onPlan
}) {
    const safeSlug = slug || (appDir || '').split('/').filter(Boolean).pop() || 'app';

    const planMessages = [
        {
            role: 'system',
            content:
                'You are a planning assistant for a browser-based app builder. ' +
                'The app must be a Vite-style React app: index.html + src/main.tsx + src/App.tsx + src/styles.css. ' +
                'No build tools, no Node runtime. CDN scripts are allowed only if explicitly needed. ' +
                'Output ONLY a single JSON object inside a ```json fenced block and nothing else. ' +
                'Schema: {' +
                '"slug": "kebab-case", "title": "...", "summary": "...", ' +
                '"libraries": [{"name": "...", "purpose": "...", "cdn": "(optional URL)"}], ' +
                '"files": [' +
                '{"path": "index.html", "purpose": "..."}, ' +
                '{"path": "src/main.tsx", "purpose": "..."}, ' +
                '{"path": "src/App.tsx", "purpose": "..."}, ' +
                '{"path": "src/styles.css", "purpose": "..."}' +
                '], ' +
                '"notes": ["..."] }'
        },
        {
            role: 'user',
            content:
                `App folder: /apps/${safeSlug}\n` +
                `Requested app name: ${safeSlug}\n\n` +
                `Task:\n${prompt}\n\n` +
                'Return the JSON plan only.'
        }
    ];

    onStatus?.('Planning app...');
    let planRaw = '';
    await llm({
        messages: planMessages,
        onDelta: (chunk) => {
            planRaw += chunk;
            onLog?.(chunk, 'plan');
        },
        onStatus
    });

    const plan = extractJsonBlock(planRaw);
    if (!plan) {
        throw new Error('Planner did not return valid JSON.');
    }
    onPlan?.(plan, planRaw);

    const generatorMessages = [
        {
            role: 'system',
            content: systemPrompt ||
                'You build Vite-style React apps for a browser-based OS. ' +
                'Return EXACTLY four fenced code blocks in this order: html, css, tsx, tsx. ' +
                'The first tsx block is src/main.tsx, the second is src/App.tsx. ' +
                'index.html must reference src/styles.css and src/main.tsx using relative paths.'
        },
        {
            role: 'user',
            content:
                `App folder: /apps/${safeSlug}\n\n` +
                `Plan (JSON):\n${JSON.stringify(plan)}\n\n` +
                `Task:\n${prompt}\n\n` +
                'Remember: output ONLY the 3 fenced blocks.'
        }
    ];

    onStatus?.('Generating files...');
    let genRaw = '';
    await llm({
        messages: generatorMessages,
        onDelta: (chunk) => {
            genRaw += chunk;
            onLog?.(chunk, 'generate');
        },
        onStatus
    });

    const blocks = extractBlocks(genRaw);
    if (!blocks.html || !blocks.css || blocks.tsx.length < 2) {
        throw new Error('Model did not return all 4 code blocks (html/css/tsx/tsx).');
    }

    const files = {
        'index.html': ensureHtmlReferences(blocks.html),
        'src/main.tsx': blocks.tsx[0],
        'src/App.tsx': blocks.tsx[1],
        'src/styles.css': blocks.css
    };

    onStatus?.('Writing files...');
    await fs.createDir('/apps');
    await fs.createDir(appDir);

    await fs.createDir(`${appDir}/src`);
    await fs.writeFile(`${appDir}/index.html`, files['index.html']);
    await fs.writeFile(`${appDir}/src/main.tsx`, files['src/main.tsx']);
    await fs.writeFile(`${appDir}/src/App.tsx`, files['src/App.tsx']);
    await fs.writeFile(`${appDir}/src/styles.css`, files['src/styles.css']);

    onStatus?.(`Saved to ${appDir}`);

    return { plan, files, planRaw, genRaw };
}

function normalizePath(root, input) {
    const raw = input && input.trim ? input.trim() : String(input || '');
    let path = raw.startsWith('/') ? raw : `${root.replace(/\/+$/, '')}/${raw}`;
    const parts = path.split('/').filter(Boolean);
    const out = [];
    for (const part of parts) {
        if (part === '.') continue;
        if (part === '..') {
            out.pop();
            continue;
        }
        out.push(part);
    }
    return '/' + out.join('/');
}

async function listTree(fs, root, depth = 2, limit = 200, prefix = '') {
    const out = [];
    const queue = [{ path: root, depth }];
    while (queue.length && out.length < limit) {
        const { path, depth: d } = queue.shift();
        const res = await fs.listFiles(path);
        if (!res || !res.success || !Array.isArray(res.data)) {
            out.push({ path, error: res?.error || 'list failed' });
            continue;
        }
        for (const entry of res.data) {
            if (out.length >= limit) break;
            const full = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
            out.push({ path: full, type: entry.type });
            if (entry.type === 'directory' && d > 0) {
                queue.push({ path: full, depth: d - 1 });
            }
        }
    }
    return out;
}

function clampText(text, max = 12000) {
    if (typeof text !== 'string') return '';
    if (text.length <= max) return text;
    return text.slice(0, max) + `\n…(truncated, ${text.length} chars total)`;
}

function isTextLikely(content) {
    if (typeof content !== 'string') return false;
    return !content.includes('\u0000');
}

async function searchTextFiles(fs, root, query, depth = 4, limit = 200, maxHits = 50) {
    const tree = await listTree(fs, root, depth, limit);
    const hits = [];
    const q = query.toLowerCase();
    for (const entry of tree) {
        if (hits.length >= maxHits) break;
        if (entry.type !== 'file') continue;
        const res = await fs.readFile(entry.path, true);
        if (!res || !res.success) continue;
        const text = res.data || '';
        if (!isTextLikely(text)) continue;
        const idx = text.toLowerCase().indexOf(q);
        if (idx !== -1) {
            const start = Math.max(0, idx - 60);
            const end = Math.min(text.length, idx + q.length + 60);
            let snippet = text.slice(start, end).replace(/\s+/g, ' ');
            if (start > 0) snippet = '…' + snippet;
            if (end < text.length) snippet = snippet + '…';
            hits.push({ path: entry.path, snippet });
        }
    }
    return { success: true, hits };
}

function applyUnifiedDiff(originalText, patchText) {
    const originalLines = originalText.split('\n');
    const patchLines = patchText.split('\n');
    const out = [];
    let i = 0;
    let lineIndex = 0;

    while (i < patchLines.length) {
        const line = patchLines[i];
        if (line.startsWith('diff --git ') || line.startsWith('index ')) {
            i++;
            continue;
        }
        if (line.startsWith('---') || line.startsWith('+++')) {
            i++;
            continue;
        }
        if (line.startsWith('@@')) {
            const m = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
            if (!m) throw new Error('Invalid hunk header');
            const oldStart = parseInt(m[1], 10) - 1;
            const hunkLines = [];
            i++;
            while (i < patchLines.length && !patchLines[i].startsWith('@@')) {
                hunkLines.push(patchLines[i]);
                i++;
            }

            while (lineIndex < oldStart) {
                out.push(originalLines[lineIndex++]);
            }

            const applyAt = (startIdx) => {
                let idx = startIdx;
                const applied = [];
                for (const hunkLine of hunkLines) {
                    if (hunkLine.startsWith('+')) {
                        applied.push(hunkLine.slice(1));
                    } else if (hunkLine.startsWith('-')) {
                        if (originalLines[idx] !== hunkLine.slice(1)) {
                            return null;
                        }
                        idx++;
                    } else if (hunkLine.startsWith(' ')) {
                        if (originalLines[idx] !== hunkLine.slice(1)) {
                            return null;
                        }
                        applied.push(originalLines[idx]);
                        idx++;
                    } else if (hunkLine.startsWith('\\')) {
                        // ignore
                    } else if (hunkLine.trim() === '') {
                        if (originalLines[idx] !== '') return null;
                        applied.push('');
                        idx++;
                    } else {
                        return null;
                    }
                }
                return { nextIndex: idx, applied };
            };

            let result = applyAt(lineIndex);
            if (!result) {
                const pattern = hunkLines
                    .filter((l) => l.startsWith(' ') || l.startsWith('-'))
                    .map((l) => l.slice(1));

                const maxStart = Math.max(0, originalLines.length - pattern.length);
                let found = -1;
                if (pattern.length === 0) {
                    found = lineIndex;
                } else {
                    for (let s = lineIndex; s <= maxStart; s++) {
                        let ok = true;
                        for (let k = 0; k < pattern.length; k++) {
                            if (originalLines[s + k] !== pattern[k]) {
                                ok = false;
                                break;
                            }
                        }
                        if (ok) {
                            found = s;
                            break;
                        }
                    }
                }

                if (found !== -1) {
                    result = applyAt(found);
                }
            }

            if (!result) {
                throw new Error('Patch mismatch on context');
            }

            out.push(...result.applied);
            lineIndex = result.nextIndex;
            continue;
        }
        i++;
    }

    while (lineIndex < originalLines.length) {
        out.push(originalLines[lineIndex++]);
    }
    return out.join('\n');
}

function parseAgentAction(raw) {
    const data = extractJsonBlock(raw);
    if (!data) return null;
    if (Array.isArray(data.actions)) {
        return { type: 'actions', actions: data.actions };
    }
    if (data.type === 'final') return data;
    if (data.type === 'tool' && data.tool) {
        const args = data.args || {};
        return { type: 'tool', tool: data.tool, args };
    }
    if (data.tool || data.action) {
        const tool = data.tool || data.action;
        if (data.args) return { type: 'tool', tool, args: data.args };
        const args = { ...data };
        delete args.tool;
        delete args.action;
        delete args.type;
        return { type: 'tool', tool, args };
    }
    return null;
}

export async function runCodingAgentFlow({
    prompt,
    llm,
    fs,
    os,
    projectRoot,
    systemPrompt,
    onLog,
    onStatus,
    maxSteps = 10,
    strictRoot = false
}) {
    const root = projectRoot || '/';
    await fs.createDir(root);
    const strictNote = strictRoot
        ? 'This is a new app. Do NOT create subdirectories. Write files directly under the project root.'
        : '';
    const toolHelp =
        'You are a coding agent inside a browser-based OS. ' +
        `Project root is ${root}. Use it exactly; do not create nested app folders unless explicitly asked. ` +
        strictNote +
        'You can only use the tools listed below. ' +
        'Return ONLY a single JSON object describing the next action. ' +
        'Do NOT wrap it in markdown fences. Do NOT include extra text. ' +
        'When finished, return type=final with a summary and files_changed.\n\n' +
        'Tools:\n' +
        '- list_dir { path }\n' +
        '- read_file { path }\n' +
        '- search { query, path?, depth?, limit? }\n' +
        '- write_file { path, content }\n' +
        '- patch { path, diff }\n' +
        '- create_dir { path }\n' +
        '- remove_path { path }\n' +
        '- npm_install { name, global }\n' +
        '- run { command }\n';

    const baseSystem = systemPrompt
        ? `${toolHelp}\nAdditional guidance:\n${systemPrompt}`
        : toolHelp;

    const tree = await listTree(fs, root, 2, 200);
    const messages = [
        { role: 'system', content: baseSystem },
        {
            role: 'user',
            content:
                `Project root: ${root}\n` +
                `User request:\n${prompt}\n\n` +
                `Project tree (depth 2):\n${JSON.stringify(tree, null, 2)}`
        }
    ];

    const writeAllowedRoot = root;

    const runTool = async (tool, args = {}) => {
        const safeArgs = args || {};
        const isStrictPathAllowed = (path) => {
            if (!strictRoot) return true;
            if (!path.startsWith(root + '/')) return false;
            const rel = path.slice(root.length + 1);
            return !rel.includes('/');
        };
        if (tool === 'list_dir') {
            const path = normalizePath(root, safeArgs.path || root);
            return await fs.listFiles(path);
        }
        if (tool === 'read_file') {
            const path = normalizePath(root, safeArgs.path || '');
            const res = await fs.readFile(path, true);
            if (res && res.success) {
                return { success: true, data: clampText(res.data || '') };
            }
            return res;
        }
        if (tool === 'search') {
            const path = normalizePath(root, safeArgs.path || root);
            const query = String(safeArgs.query || '').trim();
            if (!query) return { success: false, error: 'search missing query' };
            const depth = Number.isFinite(Number(safeArgs.depth)) ? Number(safeArgs.depth) : 4;
            const limit = Number.isFinite(Number(safeArgs.limit)) ? Number(safeArgs.limit) : 200;
            return await searchTextFiles(fs, path, query, depth, limit, 50);
        }
        if (tool === 'write_file') {
            const path = normalizePath(root, safeArgs.path || '');
            if (!path.startsWith(writeAllowedRoot)) {
                return { success: false, error: 'write_file blocked outside project root' };
            }
            if (!isStrictPathAllowed(path)) {
                return { success: false, error: 'write_file blocked in strict mode (no subdirectories)' };
            }
            return await fs.writeFile(path, safeArgs.content || '');
        }
        if (tool === 'patch') {
            const path = normalizePath(root, safeArgs.path || '');
            if (!path.startsWith(writeAllowedRoot)) {
                return { success: false, error: 'patch blocked outside project root' };
            }
            if (!isStrictPathAllowed(path)) {
                return { success: false, error: 'patch blocked in strict mode (no subdirectories)' };
            }
            const diff = String(safeArgs.diff || '');
            if (!diff.trim()) return { success: false, error: 'patch missing diff' };
            const res = await fs.readFile(path, true);
            if (!res || !res.success) return res;
            const next = applyUnifiedDiff(res.data || '', diff);
            return await fs.writeFile(path, next);
        }
        if (tool === 'create_dir') {
            const path = normalizePath(root, safeArgs.path || '');
            if (!path.startsWith(writeAllowedRoot)) {
                return { success: false, error: 'create_dir blocked outside project root' };
            }
            if (strictRoot && path !== root) {
                return { success: false, error: 'create_dir blocked in strict mode' };
            }
            return await fs.createDir(path);
        }
        if (tool === 'remove_path') {
            const path = normalizePath(root, safeArgs.path || '');
            if (!path.startsWith(writeAllowedRoot)) {
                return { success: false, error: 'remove_path blocked outside project root' };
            }
            if (!isStrictPathAllowed(path)) {
                return { success: false, error: 'remove_path blocked in strict mode (no subdirectories)' };
            }
            return await fs.remove(path);
        }
        if (tool === 'npm_install') {
            const name = String(safeArgs.name || '').trim();
            if (!name) return { success: false, error: 'npm_install missing name' };
            const prevCwd = os.shell.cwd;
            os.shell.cwd = writeAllowedRoot;
            await os.shell.npm.install(name, { global: !!safeArgs.global });
            os.shell.cwd = prevCwd;
            return { success: true };
        }
        if (tool === 'run') {
            const command = String(safeArgs.command || '').trim();
            if (!command) return { success: false, error: 'run missing command' };
            const prevCwd = os.shell.cwd;
            os.shell.cwd = writeAllowedRoot;
            await os.shell.execute(command);
            os.shell.cwd = prevCwd;
            return { success: true };
        }
        return { success: false, error: `unknown tool: ${tool}` };
    };

    let finalSummary = null;

    for (let step = 0; step < maxSteps; step++) {
        onStatus?.(`Agent step ${step + 1}/${maxSteps}...`);
        let raw = '';
        await llm({
            messages,
            onDelta: (chunk) => {
                raw += chunk;
                onLog?.(chunk, 'agent');
            }
        });

        let action = parseAgentAction(raw);
        if (!action) {
            onLog?.(`\n[FORMAT] Model did not return valid JSON. Requesting reformat...\n`, 'agent');
            messages.push({ role: 'assistant', content: raw });
            messages.push({
                role: 'user',
                content:
                    'Your previous response was invalid. ' +
                    'Return ONLY a single JSON object (no markdown, no commentary). ' +
                    'Example: {"type":"tool","tool":"list_dir","args":{"path":"/"}}'
            });
            raw = '';
            await llm({
                messages,
                onDelta: (chunk) => {
                    raw += chunk;
                    onLog?.(chunk, 'agent');
                }
            });
            action = parseAgentAction(raw);
        if (!action) {
            throw new Error('Agent output was not valid JSON action.');
        }
        }

        if (action.type === 'final') {
            finalSummary = action;
            messages.push({ role: 'assistant', content: raw });
            break;
        }

        const actions = action.type === 'actions'
            ? action.actions
            : [{ tool: action.tool, args: action.args || {} }];

        const results = [];
        for (const act of actions) {
            const tool = act.tool;
            const args = act.args || {};
            onStatus?.(`Running tool: ${tool}`);
            const result = await runTool(tool, args);
            results.push({ tool, args, result });
            if (onLog) {
                onLog(`\n${tool} ${JSON.stringify(args)}\n${JSON.stringify(result)}\n`, 'tool');
            }
        }

        messages.push({ role: 'assistant', content: raw });
        messages.push({
            role: 'user',
            content: `Tool results:\n${JSON.stringify(results, null, 2)}`
        });
    }

    return { finalSummary };
}
