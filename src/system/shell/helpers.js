import * as fs from '../../kernel/fs.js';


let esbuildPromise = null;

function normalizePath(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    const stack = [];
    for (const part of parts) {
        if (part === '.') continue;
        if (part === '..') stack.pop();
        else stack.push(part);
    }
    return '/' + stack.join('/');
}

function dirname(path) {
    if (!path || path === '/') return '/';
    const idx = path.lastIndexOf('/');
    if (idx <= 0) return '/';
    return path.slice(0, idx);
}

async function ensureEsbuild() {
    if (esbuildPromise) return esbuildPromise;
    esbuildPromise = (async () => {
        if (!window.esbuild) {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = '/vendor/esbuild-wasm.js';
                script.onload = () => resolve();
                script.onerror = () => reject(new Error('Failed to load /vendor/esbuild-wasm.js'));
                document.head.appendChild(script);
            });
        }
        const esbuild = window.esbuild;
        if (!esbuild) throw new Error('esbuild not available on window');
        await esbuild.initialize({ wasmURL: '/vendor/esbuild-wasm.wasm', worker: false });
        return esbuild;
    })();
    return esbuildPromise;
}

async function statPath(path) {
    const res = await fs.stat(path);
    if (res && res.success) return res.data;
    return { exists: false, isDir: false };
}

async function resolveWithExtensions(path) {
    const candidates = [
        path,
        `${path}.ts`,
        `${path}.tsx`,
        `${path}.js`,
        `${path}.jsx`,
        `${path}.mjs`,
        `${path}.cjs`,
        `${path}.json`,
        `${path}.css`
    ];
    for (const candidate of candidates) {
        const s = await statPath(candidate);
        if (s.exists && !s.isDir) return candidate;
    }
    const dirStat = await statPath(path);
    if (dirStat.exists && dirStat.isDir) {
        const indexCandidates = [
            `${path}/index.tsx`,
            `${path}/index.ts`,
            `${path}/index.jsx`,
            `${path}/index.js`,
            `${path}/index.mjs`
        ];
        for (const candidate of indexCandidates) {
            const s = await statPath(candidate);
            if (s.exists && !s.isDir) return candidate;
        }
    }
    return null;
}

function parsePackageName(spec) {
    if (spec.startsWith('@')) {
        const parts = spec.split('/');
        return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
    }
    return spec.split('/')[0];
}

function parseSubpath(spec, pkgName) {
    if (spec === pkgName) return '';
    if (spec.startsWith(pkgName + '/')) return spec.slice(pkgName.length + 1);
    return '';
}

function pickExportTarget(target) {
    if (!target) return null;
    if (typeof target === 'string') return target;
    if (typeof target === 'object') {
        return target.import || target.browser || target.default || target.module || target.require || null;
    }
    return null;
}

async function resolvePackageEntry(pkgRoot, pkgJson, subpath) {
    let entryRel = null;
    const exportsField = pkgJson && pkgJson.exports;
    if (exportsField) {
        if (subpath) {
            const key = `./${subpath}`;
            entryRel = pickExportTarget(exportsField[key]);
        } else {
            entryRel = pickExportTarget(exportsField['.'] || exportsField);
        }
    }
    if (!entryRel) {
        if (subpath) entryRel = subpath;
        else entryRel = pkgJson.browser || pkgJson.module || pkgJson.main || 'index.js';
    }
    if (!entryRel) return null;
    const fullPath = normalizePath(`${pkgRoot}/${entryRel}`);
    return await resolveWithExtensions(fullPath);
}

async function resolveBarePath(spec, appRoot) {
    const pkgName = parsePackageName(spec);
    const subpath = parseSubpath(spec, pkgName);
    const appNodeModules = `${appRoot}/node_modules/${pkgName}`;
    const globalNodeModules = `/usr/lib/node_modules/${pkgName}`;
    const globalSingleFile = `/usr/lib/node_modules/${pkgName}.js`;

    const appStat = await statPath(appNodeModules);
    const pkgRoot = appStat.exists && appStat.isDir ? appNodeModules : globalNodeModules;
    const pkgRootStat = await statPath(pkgRoot);
    if (!pkgRootStat.exists) {
        const fileStat = await statPath(globalSingleFile);
        if (fileStat.exists && !fileStat.isDir) return globalSingleFile;
        throw new Error(`Package not found: ${pkgName}`);
    }

    let pkgJson = {};
    try {
        const res = await fs.readFile(`${pkgRoot}/package.json`, true);
        if (res && res.success && res.data) pkgJson = JSON.parse(res.data);
    } catch {}

    const entryPath = await resolvePackageEntry(pkgRoot, pkgJson, subpath);
    if (!entryPath) throw new Error(`Entry not found for ${spec}`);
    return entryPath;
}

function guessLoader(path) {
    const lower = path.toLowerCase();
    if (lower.endsWith('.tsx')) return 'tsx';
    if (lower.endsWith('.ts')) return 'ts';
    if (lower.endsWith('.tsc')) return 'ts';
    if (lower.endsWith('.jsx')) return 'jsx';
    if (lower.endsWith('.json')) return 'json';
    if (lower.endsWith('.css')) return 'css';
    if (/\.(png|jpe?g|gif|svg|webp|ico|bmp|avif)$/.test(lower)) return 'file';
    if (/\.(woff2?|ttf|otf|eot)$/.test(lower)) return 'file';
    return 'js';
}

function findModuleEntry(html) {
    const re = /<script\b[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/i;
    const match = re.exec(html || '');
    return match ? match[1] : '';
}

function rewriteIndexHtml(html, scriptPath, cssPath) {
    let out = html || '';
    let replacedScript = false;
    out = out.replace(/<script\b[^>]*type=["']module["'][^>]*src=["'][^"']+["'][^>]*>\s*<\/script>/gi, (match) => {
        if (replacedScript) return match;
        replacedScript = true;
        return `<script type="module" src="${scriptPath}"></script>`;
    });
    if (!replacedScript) {
        if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `<script type="module" src="${scriptPath}"></script>\n</body>`);
        else out += `\n<script type="module" src="${scriptPath}"></script>`;
    }

    out = out.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["'][^"']*styles\.css["'][^>]*>/gi, `<link rel="stylesheet" href="${cssPath}">`);
    const hasAppCss = /<link[^>]*rel=["']stylesheet["'][^>]*href=["'][^"']*app\.css["'][^>]*>/i.test(out);
    if (!hasAppCss) {
        if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, `<link rel="stylesheet" href="${cssPath}">\n</head>`);
        else out = `<head>\n<link rel="stylesheet" href="${cssPath}">\n</head>\n` + out;
    }
    return out;
}

async function copyDirRecursive(srcDir, destDir, options, rootDir = srcDir) {
    const { excludeDirs, skipRootIndex } = options || {};
    const res = await fs.listFiles(srcDir);
    if (!res || !res.success || !Array.isArray(res.data)) return;
    for (const entry of res.data) {
        const srcPath = srcDir === '/' ? `/${entry.name}` : `${srcDir}/${entry.name}`;
        const destPath = destDir === '/' ? `/${entry.name}` : `${destDir}/${entry.name}`;
        if (entry.type === 'directory') {
            if (excludeDirs && excludeDirs.has(entry.name) && srcDir === rootDir) continue;
            await fs.createDir(destPath);
            await copyDirRecursive(srcPath, destPath, options, rootDir);
            continue;
        }
        if (skipRootIndex && srcDir === rootDir && entry.name === 'index.html') continue;
        const dataRes = await fs.readFile(srcPath, false);
        if (dataRes && dataRes.success) {
            await fs.writeFile(destPath, dataRes.data);
        }
    }
}

export {
    normalizePath,
    dirname,
    ensureEsbuild,
    statPath,
    resolveWithExtensions,
    parsePackageName,
    parseSubpath,
    pickExportTarget,
    resolvePackageEntry,
    resolveBarePath,
    guessLoader,
    findModuleEntry,
    rewriteIndexHtml,
    copyDirRecursive
};
