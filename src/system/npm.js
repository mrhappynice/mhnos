// src/system/npm.js
import * as fs from '../kernel/fs.js';

function bodyToText(body) {
    if (typeof body === 'string') return body;
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
    if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body.buffer);
    return body ? String(body) : '';
}

function splitPackageSpecifier(spec) {
    const trimmed = spec.trim();
    if (!trimmed) return { name: '', version: '' };
    if (trimmed.startsWith('@')) {
        const atIndex = trimmed.indexOf('@', 1);
        if (atIndex === -1) return { name: trimmed, version: '' };
        return { name: trimmed.slice(0, atIndex), version: trimmed.slice(atIndex + 1) };
    }
    const atIndex = trimmed.indexOf('@');
    if (atIndex === -1) return { name: trimmed, version: '' };
    return { name: trimmed.slice(0, atIndex), version: trimmed.slice(atIndex + 1) };
}

function registryUrlForPackage(name) {
    if (name.startsWith('@')) {
        return `https://registry.npmjs.org/${encodeURIComponent(name)}`;
    }
    return `https://registry.npmjs.org/${name}`;
}

function parseVersion(v) {
    const clean = v.trim().replace(/^v/, '');
    const parts = clean.split('-')[0].split('.').map(n => parseInt(n, 10));
    if (parts.some(n => Number.isNaN(n))) return null;
    return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0, raw: clean };
}

function compareVersions(a, b) {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    return a.patch - b.patch;
}

function satisfies(version, spec) {
    if (!spec || spec === 'latest') return true;
    if (spec.startsWith('^')) {
        const base = parseVersion(spec.slice(1));
        if (!base) return false;
        if (version.major !== base.major) return false;
        return compareVersions(version, base) >= 0;
    }
    if (spec.startsWith('~')) {
        const base = parseVersion(spec.slice(1));
        if (!base) return false;
        if (version.major !== base.major || version.minor !== base.minor) return false;
        return compareVersions(version, base) >= 0;
    }
    if (spec.startsWith('>=')) {
        const base = parseVersion(spec.slice(2));
        if (!base) return false;
        return compareVersions(version, base) >= 0;
    }
    if (spec.startsWith('>')) {
        const base = parseVersion(spec.slice(1));
        if (!base) return false;
        return compareVersions(version, base) > 0;
    }
    if (spec.startsWith('<=')) {
        const base = parseVersion(spec.slice(2));
        if (!base) return false;
        return compareVersions(version, base) <= 0;
    }
    if (spec.startsWith('<')) {
        const base = parseVersion(spec.slice(1));
        if (!base) return false;
        return compareVersions(version, base) < 0;
    }
    return version.raw === spec.replace(/^v/, '');
}

function resolveVersion(meta, versionSpec) {
    const distTags = meta['dist-tags'] || {};
    if (!versionSpec) return distTags.latest;
    if (distTags[versionSpec]) return distTags[versionSpec];

    const exact = meta.versions && meta.versions[versionSpec];
    if (exact) return versionSpec;

    const invalidRange = versionSpec.includes('||') || versionSpec.includes(' ');
    if (invalidRange) return distTags.latest;

    const versions = Object.keys(meta.versions || {})
        .map(parseVersion)
        .filter(v => v);

    const candidates = versions.filter(v => satisfies(v, versionSpec));
    if (!candidates.length) return distTags.latest;
    candidates.sort(compareVersions);
    return candidates[candidates.length - 1].raw;
}

async function gunzipArrayBuffer(buffer) {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('DecompressionStream not available for gzip');
    }
    const stream = new DecompressionStream('gzip');
    const response = new Response(new Blob([buffer]).stream().pipeThrough(stream));
    return await response.arrayBuffer();
}

function parseTar(buffer) {
    const out = [];
    const view = new Uint8Array(buffer);
    const decoder = new TextDecoder();
    let offset = 0;

    while (offset + 512 <= view.length) {
        const header = view.slice(offset, offset + 512);
        offset += 512;
        const nameRaw = decoder.decode(header.slice(0, 100)).replace(/\0.*$/, '');
        if (!nameRaw) break;
        const sizeRaw = decoder.decode(header.slice(124, 136)).replace(/\0.*$/, '').trim();
        const size = sizeRaw ? parseInt(sizeRaw, 8) : 0;
        const typeflag = header[156];

        const data = view.slice(offset, offset + size);
        offset += size;
        if (size % 512 !== 0) offset += (512 - (size % 512));

        out.push({ path: nameRaw, typeflag, data });
    }

    return out;
}

const RECIPES = {
    // --- RECIPE: EXPRESS (Robust Shim) ---
    'express': async () => {
        return `
const http = require('http');
const querystring = require('querystring');
function createApplication() {
    const app = function(req, res, next) { app.handle(req, res, next); };
    app.routes = [];
    app.use = (fn) => app.routes.push({ path: '/', fn, method: null });
    app.get = (path, fn) => app.routes.push({ path, fn, method: 'GET' });
    app.post = (path, fn) => app.routes.push({ path, fn, method: 'POST' });
    app.handle = (req, res) => {
        res.send = (body) => {
            if(typeof body === 'object') return res.json(body);
            res.setHeader('Content-Type', 'text/html');
            res.end(body);
        };
        res.json = (body) => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(body));
        };
        res.status = (c) => { res.statusCode = c; return res; };
        
        const [pathStr, queryStr] = req.url.split('?');
        req.path = pathStr;
        req.query = queryStr ? querystring.parse(queryStr) : {};

        const matched = app.routes.find(r => 
            (r.method === req.method || r.method === null) && 
            (req.path === r.path || r.path === '*')
        );

        if (matched) {
            try {
                matched.fn(req, res);
            } catch (err) {
                console.error("SERVER ERROR:", err);
                res.writeHead(500);
                res.end("Server Error: " + err.message);
            }
        } else {
            res.writeHead(404);
            res.end(\`Cannot \${req.method} \${req.path}\`);
        }
    };
    app.listen = (port, cb) => {
        const server = http.createServer(app);
        server.on('error', (e) => console.error("Network Error:", e));
        return server.listen(port, cb);
    };
    return app;
}
module.exports = createApplication;
        `.trim();
    },

    // --- RECIPE: REACT (Robust UMD Wrapper) ---
    'react': async (fetcher) => {
        const res = await fetcher('https://unpkg.com/react@18.2.0/umd/react.development.js', { responseType: 'text' });
        if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
        const code = bodyToText(res.body);
        const indexJs = `
// 1. Run the UMD code
${code}

// 2. WebOS Shim:
// The UMD might have attached to 'exports' OR 'self.React'.
// We ensure module.exports is the full React object.
if (self.React) {
    module.exports = self.React;
} else if (!module.exports.createElement && exports.createElement) {
    module.exports = exports;
    self.React = exports; // Ensure global for react-dom
}
if (!self.React && module.exports && module.exports.createElement) {
    self.React = module.exports;
}
`;
        const indexMjs = `
import ReactCjs from './index.js';
const React = ReactCjs || globalThis.React || (typeof self !== 'undefined' ? self.React : undefined);
if (!React) throw new Error('React UMD did not initialize global React');
export const useMemo = React.useMemo;
export const useState = React.useState;
export const useEffect = React.useEffect;
export const useRef = React.useRef;
export const useCallback = React.useCallback;
export const useLayoutEffect = React.useLayoutEffect;
export const useReducer = React.useReducer;
export const useContext = React.useContext;
export const useImperativeHandle = React.useImperativeHandle;
export const useDebugValue = React.useDebugValue;
export const useId = React.useId;
export const useDeferredValue = React.useDeferredValue;
export const useTransition = React.useTransition;
export const useSyncExternalStore = React.useSyncExternalStore;
export const ReactSharedInternals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
export const __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
export const Component = React.Component;
export const PureComponent = React.PureComponent;
export const createContext = React.createContext;
export const createRef = React.createRef;
export const forwardRef = React.forwardRef;
export const memo = React.memo;
export const lazy = React.lazy;
export const Children = React.Children;
export const cloneElement = React.cloneElement;
export const isValidElement = React.isValidElement;
export const StrictMode = React.StrictMode;
export const Suspense = React.Suspense;
export const startTransition = React.startTransition;
export const createElement = React.createElement;
export const Fragment = React.Fragment;
export default React;
`.trim();
        const pkgJson = JSON.stringify({
            name: 'react',
            version: '18.2.0',
            main: 'index.js',
            exports: {
                '.': './index.mjs'
            }
        }, null, 2);
        return {
            files: {
                'react/index.js': indexJs,
                'react/index.mjs': indexMjs,
                'react/package.json': pkgJson
            }
        };
    },

    // --- RECIPE: REACT-DOM (SSR Legacy UMD Wrapper) ---
    'react-dom': async (fetcher) => {
        const clientRes = await fetcher('https://unpkg.com/react-dom@18.2.0/umd/react-dom.development.js', { responseType: 'text' });
        if (clientRes.statusCode !== 200) throw new Error(`HTTP ${clientRes.statusCode}`);
        const clientCode = bodyToText(clientRes.body);

        // Use legacy server build to ensure renderToString/renderToStaticMarkup are present.
        const serverRes = await fetcher('https://unpkg.com/react-dom@18.2.0/umd/react-dom-server-legacy.browser.development.js', { responseType: 'text' });
        if (serverRes.statusCode !== 200) throw new Error(`HTTP ${serverRes.statusCode}`);
        const serverCode = bodyToText(serverRes.body);

        const indexJs = `
// 1. Ensure React is available globally (UMD fallback)
if (!self.React) {
    try { self.React = require('react'); } catch(e) {}
}

// 2. Run UMD Code (client build)
${clientCode}

// 3. WebOS Shim: Force export of ReactDOM
if (self.ReactDOM) {
    module.exports = self.ReactDOM;
} else if (typeof ReactDOM !== 'undefined') {
    module.exports = ReactDOM;
} else if (typeof exports !== 'undefined' && (exports.createRoot || exports.render)) {
    module.exports = exports;
}
`;

        const clientJs = `
import ReactDOM from './index.js';
export const createRoot = ReactDOM.createRoot || ReactDOM.unstable_createRoot;
export const hydrateRoot = ReactDOM.hydrateRoot || ReactDOM.unstable_hydrateRoot;
export const version = ReactDOM.version;
export default ReactDOM;
`.trim();

        const serverJs = `
// 1. Ensure React is available globally (UMD fallback)
if (!self.React) {
    try { self.React = require('react'); } catch(e) {}
}

// 2. Run UMD Code (server legacy build)
${serverCode}

// 3. WebOS Shim: Force export of ReactDOMServer
if (self.ReactDOMServer) {
    module.exports = self.ReactDOMServer;
} else if (self.ReactDOMServerBrowser) {
    module.exports = self.ReactDOMServerBrowser;
} else if (typeof ReactDOMServer !== 'undefined') {
    module.exports = ReactDOMServer;
} else if (typeof exports !== 'undefined' && (exports.renderToString || exports.renderToStaticMarkup)) {
    module.exports = exports;
}
`;

        const pkgJson = JSON.stringify({
            name: 'react-dom',
            version: '18.2.0',
            main: 'index.js',
            exports: {
                '.': './index.js',
                './client': './client.mjs',
                './server': './server.js',
                './server.browser': './server.js'
            }
        }, null, 2);

        return {
            files: {
                'react-dom/index.js': indexJs,
                'react-dom/client.mjs': clientJs,
                'react-dom/server.js': serverJs,
                'react-dom/package.json': pkgJson
            }
        };
    }
};

export class PackageManager {
    constructor(shell) {
        this.shell = shell;
        this._seen = new Set();
    }

    async install(pkgName, options = {}) {
        const { global = false, targetDir = null, skipDeps = false } = options;
        const cwd = this.shell.cwd;
        const baseDir = targetDir
            ? targetDir
            : (global ? '/usr/lib/node_modules' : (cwd === '/' ? '/node_modules' : `${cwd}/node_modules`));
        await fs.createDir(baseDir);

        this.shell.print(`[NPM] Resolving ${pkgName}...`, 'system');

        let code = null;
        try {
            if (RECIPES[pkgName]) {
                this.shell.print(`[NPM] Using custom recipe for ${pkgName}...`, 'system');
                code = await RECIPES[pkgName](this.shell.os.fetch.bind(this.shell.os));
                if (code && typeof code === 'object' && code.files) {
                    const entries = Object.entries(code.files);
                    for (const [relPath, content] of entries) {
                        const fullPath = `${baseDir}/${relPath}`;
                        const dirPath = fullPath.split('/').slice(0, -1).join('/');
                        if (dirPath) await fs.createDir(dirPath);
                        await fs.writeFile(fullPath, content);
                    }
                } else {
                    const filePath = `${baseDir}/${pkgName}.js`;
                    await fs.writeFile(filePath, code);
                }
                this.shell.print(`[NPM] ${pkgName} installed successfully.`, 'success');
                return;
            }

            await this.installFromRegistry(pkgName, { global, baseDir, skipDeps });

        } catch (e) {
            this.shell.print(`[NPM] Install Failed: ${e.message}`, 'error');
        }
    }

    async installFromPackageJson(packagePath) {
        const res = await fs.readFile(packagePath, true);
        if (!res.success) {
            this.shell.print(`[NPM] ${packagePath} not found.`, 'error');
            return;
        }

        let parsed = null;
        try {
            parsed = JSON.parse(res.data);
        } catch (e) {
            this.shell.print(`[NPM] Invalid JSON in ${packagePath}.`, 'error');
            return;
        }

        const deps = parsed && parsed.dependencies ? Object.keys(parsed.dependencies) : [];
        if (deps.length === 0) {
            this.shell.print('[NPM] No dependencies found in package.json.', 'system');
            return;
        }

        this.shell.print(`[NPM] Installing ${deps.length} dependencies...`, 'system');
        for (const dep of deps) {
            await this.install(dep);
        }
    }

    async installFromRegistry(spec, options = {}) {
        const { global = false, baseDir, skipDeps = false } = options;
        const { name, version } = splitPackageSpecifier(spec);
        if (!name) throw new Error('Invalid package name');

        const seenKey = `${name}@${version || 'latest'}`;
        if (this._seen.has(seenKey)) return;
        this._seen.add(seenKey);

        const packumentUrl = registryUrlForPackage(name);
        this.shell.print(`[NPM] Fetching registry metadata for ${name}...`, 'system');

        const metaRes = await this.shell.os.fetch(packumentUrl, { responseType: 'text' });
        if (metaRes.statusCode !== 200) throw new Error(`Registry HTTP ${metaRes.statusCode}`);
        const meta = JSON.parse(bodyToText(metaRes.body) || '{}');
        const resolvedVersion = resolveVersion(meta, version || '');
        const versionMeta = (meta.versions && meta.versions[resolvedVersion]) ? meta.versions[resolvedVersion] : null;
        if (!versionMeta || !versionMeta.dist || !versionMeta.dist.tarball) {
            throw new Error(`Version not found: ${resolvedVersion || 'latest'}`);
        }

        const tarballUrl = versionMeta.dist.tarball;
        this.shell.print(`[NPM] Downloading ${name}@${resolvedVersion}...`, 'system');
        const tarRes = await this.shell.os.fetch(tarballUrl, { responseType: 'arraybuffer' });
        if (tarRes.statusCode !== 200) throw new Error(`Tarball HTTP ${tarRes.statusCode}`);

        const tgzBuffer = tarRes.body instanceof ArrayBuffer
            ? tarRes.body
            : new TextEncoder().encode(String(tarRes.body || '')).buffer;

        const tarBuffer = await gunzipArrayBuffer(tgzBuffer);
        const entries = parseTar(tarBuffer);

        const pkgRoot = `${baseDir}/${name}`;
        await fs.createDir(pkgRoot);

        let pkgJson = null;
        for (const entry of entries) {
            const rawPath = entry.path.replace(/^package\//, '');
            if (!rawPath) continue;
            if (entry.typeflag === 53) {
                await fs.createDir(`${pkgRoot}/${rawPath}`);
                continue;
            }
            if (entry.typeflag !== 48 && entry.typeflag !== 0) continue;

            const fullPath = `${pkgRoot}/${rawPath}`;
            const dirPath = fullPath.split('/').slice(0, -1).join('/');
            if (dirPath) await fs.createDir(dirPath);

            const data = entry.data.slice().buffer;
            await fs.writeFile(fullPath, data);

            if (rawPath === 'package.json') {
                try {
                    const text = new TextDecoder().decode(entry.data);
                    pkgJson = JSON.parse(text);
                } catch {}
            }
        }

        this.shell.print(`[NPM] Installed ${name}@${resolvedVersion} to ${pkgRoot}`, 'success');

        if (global && pkgJson && pkgJson.bin) {
            await fs.createDir('/usr');
            await fs.createDir('/usr/bin');
            const bins = typeof pkgJson.bin === 'string' ? { [name]: pkgJson.bin } : pkgJson.bin;
            for (const [binName, binRelPath] of Object.entries(bins || {})) {
                const targetPath = `${pkgRoot}/${binRelPath}`;
                const shimPath = `/usr/bin/${binName}.js`;
                const shim = `module.exports = require('${targetPath}');`;
                await fs.writeFile(shimPath, shim);
                this.shell.print(`[NPM] Linked bin ${binName} -> ${shimPath}`, 'system');
            }
        }

        if (!skipDeps && pkgJson && pkgJson.dependencies) {
            const depNames = Object.keys(pkgJson.dependencies);
            if (depNames.length) {
                const depDir = `${pkgRoot}/node_modules`;
                await fs.createDir(depDir);
                for (const dep of depNames) {
                    await this.install(dep, { global: false, targetDir: depDir, skipDeps: false });
                }
            }
        }
    }
}
