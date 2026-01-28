// mhnos-sw.js
const DEP_CACHE_DIR = '/usr/cache/vite/deps';
const DEP_CACHE_VERSION = '8';
const TOOLING_WORKER_URL = '/mhnos-vite-worker.js?v=18';
const USE_TOOLING_WORKER = typeof Worker !== 'undefined';

const rpcPending = new Map();
let rpcId = 1;
let kernelClientId = null;

const depRegistry = new Map();
const depBundles = new Map();
const depInflight = new Map();
const moduleCache = new Map();
const DISABLE_MODULE_CACHE = true;

let toolWorker = null;
let toolPending = new Map();
let toolReqId = 1;
let esbuild = null;
let esbuildInit = null;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'SW_KERNEL_READY') {
    kernelClientId = event.source && event.source.id ? event.source.id : kernelClientId;
    return;
  }
  if (msg.type === 'SW_RPC_RESPONSE') {
    const pending = rpcPending.get(msg.id);
    if (pending) {
      rpcPending.delete(msg.id);
      msg.ok ? pending.resolve(msg.data) : pending.reject(new Error(msg.error || 'rpc failed'));
    }
    return;
  }
  if (msg.type === 'FS_FILE_CHANGED') {
    moduleCache.delete(msg.path);
    return;
  }
});

function getClientById(clientId) {
  if (!clientId) return null;
  return self.clients.get(clientId);
}

async function logToClient(clientId, level, message) {
  try {
    const client = kernelClientId
      ? await getClientById(kernelClientId)
      : await getClientById(clientId);
    if (client) client.postMessage({ type: 'SW_LOG', level, message });
  } catch {
    // ignore
  }
}

async function pickClient(clientId) {
  if (kernelClientId) {
    const kernel = await getClientById(kernelClientId);
    if (kernel) return kernel;
  }
  const client = await getClientById(clientId);
  if (client) return client;
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (!all.length) return null;
  const rootClient = all.find((c) => c.url.endsWith('/index.html') || c.url.endsWith('/'));
  return rootClient || all[0];
}

async function rpc(method, params, clientId) {
  const client = await pickClient(clientId);
  if (!client) throw new Error('No client available for RPC');
  const id = rpcId++;
  const payload = { type: 'SW_RPC_REQUEST', id, method, params };
  const promise = new Promise((resolve, reject) => {
    rpcPending.set(id, { resolve, reject });
  });
  client.postMessage(payload);
  return promise;
}

function normalizeFsPath(path) {
  if (!path) return path;
  if (path.startsWith('ops:')) return path.slice(4);
  if (path.startsWith('opfs:')) return path.slice(5);
  if (path.startsWith('file://')) return path.replace('file://', '');
  return path;
}

function isTextPath(path) {
  const lower = path.toLowerCase();
  return /\.(js|mjs|cjs|ts|tsx|jsx|json|css|html|htm|txt|md|svg)$/.test(lower);
}

function normalizePath(path) {
  const parts = path.split('/').filter(Boolean);
  const stack = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return '/' + stack.join('/');
}

function joinPath(base, rel) {
  if (rel.startsWith('/')) return normalizePath(rel);
  const baseDir = base.endsWith('/') ? base : base.slice(0, base.lastIndexOf('/') + 1);
  return normalizePath(baseDir + rel);
}

function dirname(path) {
  if (!path || path === '/') return '/';
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '/';
  return path.slice(0, idx);
}

function parsePackageName(spec) {
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
  }
  const parts = spec.split('/');
  return parts[0];
}

function parseSubpath(spec, pkgName) {
  if (spec === pkgName) return '';
  if (spec.startsWith(pkgName + '/')) return spec.slice(pkgName.length + 1);
  return '';
}

async function readFile(path, asText, clientId) {
  const normalized = normalizeFsPath(path);
  return await rpc('fs.readFile', { path: normalized, asText: !!asText }, clientId);
}

async function writeFile(path, content, clientId) {
  const normalized = normalizeFsPath(path);
  return await rpc('fs.writeFile', { path: normalized, content }, clientId);
}

async function stat(path, clientId) {
  try {
    const normalized = normalizeFsPath(path);
    return await rpc('fs.stat', { path: normalized }, clientId);
  } catch {
    return null;
  }
}

async function resolveWithExtensions(path, clientId) {
  const candidates = [
    path,
    `${path}.ts`,
    `${path}.tsx`,
    `${path}.js`,
    `${path}.jsx`,
    `${path}.mjs`,
    `${path}.cjs`,
    `${path}.json`
  ];
  for (const candidate of candidates) {
    const s = await stat(candidate, clientId);
    if (s && s.exists && !s.isDir) return candidate;
  }
  const dirStat = await stat(path, clientId);
  if (dirStat && dirStat.exists && dirStat.isDir) {
    const indexCandidates = [
      `${path}/index.tsx`,
      `${path}/index.ts`,
      `${path}/index.jsx`,
      `${path}/index.js`,
      `${path}/index.mjs`
    ];
    for (const candidate of indexCandidates) {
      const s = await stat(candidate, clientId);
      if (s && s.exists && !s.isDir) return candidate;
    }
  }
  return null;
}

function pickExportTarget(target) {
  if (!target) return null;
  if (typeof target === 'string') return target;
  if (typeof target === 'object') {
    return target.import || target.browser || target.default || target.module || target.require || null;
  }
  return null;
}

async function resolvePackageEntry(pkgRoot, pkgJson, subpath, clientId) {
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
  return await resolveWithExtensions(fullPath, clientId);
}

async function resolveBare(spec, appRoot, clientId) {
  const pkgName = parsePackageName(spec);
  const subpath = parseSubpath(spec, pkgName);
  const appNodeModules = `${appRoot}/node_modules/${pkgName}`;
  const globalNodeModules = `/usr/lib/node_modules/${pkgName}`;
  const globalSingleFile = `/usr/lib/node_modules/${pkgName}.js`;
  if (spec.includes('react-dom')) {
    await logToClient(clientId, 'system', `resolveBare ${spec} appRoot=${appRoot} pkg=${pkgName} sub=${subpath || '(none)'}`);
  }

  const appStat = await stat(appNodeModules, clientId);
  const appExists = appStat && appStat.exists && appStat.isDir;

  const tryResolveAt = async (pkgRoot) => {
    const pkgRootStat = await stat(pkgRoot, clientId);
    if (!pkgRootStat || !pkgRootStat.exists) return null;
    let pkgJson = {};
    const pkgJsonPath = `${pkgRoot}/package.json`;
    try {
      const pkgText = await readFile(pkgJsonPath, true, clientId);
      pkgJson = JSON.parse(pkgText || '{}');
    } catch {
      pkgJson = {};
    }
    const entryPath = await resolvePackageEntry(pkgRoot, pkgJson, subpath, clientId);
    if (!entryPath) return null;
    const entryStat = await stat(entryPath, clientId);
    if (!entryStat || !entryStat.exists || entryStat.isDir) return null;
    return {
      pkgName,
      subpath,
      version: pkgJson.version || '0.0.0',
      entryPath
    };
  };

  let resolved = null;
  if (appExists) {
    resolved = await tryResolveAt(appNodeModules);
  }
  if (!resolved) {
    resolved = await tryResolveAt(globalNodeModules);
  }
  if (resolved) {
    if (spec.includes('react-dom')) {
      await logToClient(clientId, 'system', `resolveBare ${spec} -> ${resolved.entryPath}`);
    }
    return resolved;
  }

  const fileStat = await stat(globalSingleFile, clientId);
  if (fileStat && fileStat.exists && !fileStat.isDir) {
    return {
      pkgName,
      subpath,
      version: '0.0.0',
      entryPath: globalSingleFile
    };
  }
  throw new Error(`Package not found: ${pkgName}`);
}

function depKeyFor(info) {
  const safeName = info.pkgName.replace(/[@/]/g, '_');
  const safeSub = info.subpath ? '_' + info.subpath.replace(/[\\/]/g, '_') : '';
  return `${safeName}${safeSub}@${info.version}.v${DEP_CACHE_VERSION}.js`;
}

async function ensureDep(spec, appRoot, clientId) {
  const info = await resolveBare(spec, appRoot, clientId);
  const key = depKeyFor(info);
  const url = `/@deps/${key}`;
  const existing = depRegistry.get(key);
  if (existing) {
    try {
      const s = await stat(existing.entryPath, clientId);
      if (s && s.exists && !s.isDir) return url;
    } catch {
      // fall through to refresh
    }
  }
  depRegistry.set(key, { ...info, key, url, appRoot });
  return url;
}

function guessLoader(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts')) return 'ts';
  if (lower.endsWith('.tsc')) return 'ts';
  if (lower.endsWith('.jsx')) return 'jsx';
  if (lower.endsWith('.mjs')) return 'js';
  return 'js';
}

function rewriteImports(code, mapping) {
  let out = code;
  for (const [spec, url] of mapping) {
    const safe = spec.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
    const reFrom = new RegExp(`from\\s*['\"]${safe}['\"]`, 'g');
    const reBare = new RegExp(`import\\s*['\"]${safe}['\"]`, 'g');
    const reImport = new RegExp(`import\\(\\s*['\"]${safe}['\"]\\s*\\)`, 'g');
    out = out
      .replace(reFrom, `from '${url}'`)
      .replace(reBare, `import '${url}'`)
      .replace(reImport, `import('${url}')`);
  }
  return out;
}

function rewriteRelativeImports(code) {
  return code;
}

function findImports(code) {
  const out = [];
  const reList = [
    /import\s+[^'\"]*?from\s*['\"]([^'\"]+)['\"]/g,
    /import\s*['\"]([^'\"]+)['\"]/g,
    /export\s+[^'\"]*?from\s*['\"]([^'\"]+)['\"]/g,
    /import\(\s*['\"]([^'\"]+)['\"]\s*\)/g
  ];
  for (const re of reList) {
    let m;
    while ((m = re.exec(code)) !== null) out.push(m[1]);
  }
  return Array.from(new Set(out));
}

function ensureToolingWorker() {
  if (!USE_TOOLING_WORKER) return;
  if (toolWorker) return;
  toolWorker = new Worker(TOOLING_WORKER_URL);
  toolWorker.onmessage = async (event) => {
    const msg = event.data || {};
    if (msg.type === 'tool_response') {
      const pending = toolPending.get(msg.id);
      if (pending) {
        toolPending.delete(msg.id);
        msg.ok ? pending.resolve(msg.result) : pending.reject(new Error(msg.error || 'tool failed'));
      }
      return;
    }
    if (msg.type === 'fs_read') {
      try {
        const data = await readFile(msg.path, msg.asText, msg.clientId);
        toolWorker.postMessage({ type: 'fs_read_response', id: msg.id, ok: true, data });
      } catch (e) {
        toolWorker.postMessage({ type: 'fs_read_response', id: msg.id, ok: false, error: e.message || String(e) });
      }
      return;
    }
    if (msg.type === 'fs_stat') {
      try {
        const data = await stat(msg.path, msg.clientId);
        toolWorker.postMessage({ type: 'fs_stat_response', id: msg.id, ok: true, data });
      } catch (e) {
        toolWorker.postMessage({ type: 'fs_stat_response', id: msg.id, ok: false, error: e.message || String(e) });
      }
      return;
    }
  };
}

async function toolCall(action, payload) {
  if (!USE_TOOLING_WORKER) {
    if (action === 'transform') {
      try {
        const local = await transformModuleInline(payload);
        if (local) return local;
      } catch {
        // fall through to kernel
      }
      return await rpc('tool.transform', payload, payload.clientId);
    }
    if (action === 'bundle') {
      try {
        const local = await bundleDepInline(payload);
        if (local) return local;
      } catch (e) {
        await logToClient(payload.clientId, 'error', `inline bundle failed, falling back to kernel: ${e.message || e}`);
      }
      return await rpc('tool.bundle', payload, payload.clientId);
    }
    throw new Error(`unknown action: ${action}`);
  }
  ensureToolingWorker();
  const id = toolReqId++;
  const promise = new Promise((resolve, reject) => {
    toolPending.set(id, { resolve, reject });
  });
  toolWorker.postMessage({ type: 'tool_request', id, action, payload });
  return promise;
}

async function transformModule(code, loader, sourcefile, clientId) {
  return await toolCall('transform', { code, loader, sourcefile, clientId });
}

async function ensureEsbuild() {
  if (esbuildInit) return esbuildInit;
  esbuildInit = (async () => {
    try {
      const origin = self.location && self.location.origin ? self.location.origin : '';
      const scope = (self.registration && self.registration.scope) ? self.registration.scope : origin + '/';
      const scopedVendor = scope.endsWith('/') ? `${scope}vendor/esbuild-wasm.js` : `${scope}/vendor/esbuild-wasm.js`;
      const opfsVendorJs = '/vendor/esbuild-wasm.js';
      const opfsVendorWasm = '/vendor/esbuild-wasm.wasm';
      if (!self.esbuild) {
        if (typeof importScripts !== 'function') {
          await logToClient(kernelClientId, 'error', 'importScripts is not available in SW (module SW?)');
          return null;
        }
        const candidates = [
          '/vendor/esbuild-wasm.js',
          scopedVendor,
          `${origin}/vendor/esbuild-wasm.js`
        ];
        let loaded = false;
        for (const url of candidates) {
          if (loaded) break;
          try {
            importScripts(url);
            loaded = true;
          } catch (e) {
            await logToClient(kernelClientId, 'error', `importScripts failed (${url}): ${e.message || e}`);
          }
        }
        if (!loaded) {
          for (const url of candidates) {
            try {
              const res = await fetch(url, { cache: 'no-store' });
              if (!res.ok) {
                await logToClient(kernelClientId, 'error', `fetch failed (${url}): HTTP ${res.status}`);
                continue;
              }
              const text = await res.text();
              try {
                const fn = new Function(text);
                fn();
                loaded = true;
                break;
              } catch (e) {
                await logToClient(kernelClientId, 'error', `eval failed (${url}): ${e.message || e}`);
              }
            } catch (e) {
              await logToClient(kernelClientId, 'error', `fetch/import failed (${url}): ${e.message || e}`);
            }
          }
        }
        if (!loaded) {
          try {
            const text = await rpc('fs.readFile', { path: opfsVendorJs, asText: true }, kernelClientId);
            if (text) {
              const fn = new Function(text);
              fn();
              loaded = true;
              await logToClient(kernelClientId, 'system', `esbuild loaded from OPFS (${opfsVendorJs})`);
            }
          } catch (e) {
            await logToClient(kernelClientId, 'error', `opfs import failed (${opfsVendorJs}): ${e.message || e}`);
          }
        }
        if (!loaded) return null;
      }
      esbuild = self.esbuild || null;
      if (!esbuild) {
        await logToClient(kernelClientId, 'error', 'esbuild not found on self after importScripts');
      }
      if (!esbuild) return null;
      const wasmUrl = scopedVendor.replace(/esbuild-wasm\.js$/, 'esbuild-wasm.wasm');
      let wasmModule = null;
      try {
        const res = await fetch(wasmUrl, { cache: 'no-store' });
        if (!res.ok) {
          await logToClient(kernelClientId, 'error', `wasm fetch failed (${wasmUrl}): HTTP ${res.status}`);
        } else {
          const buf = await res.arrayBuffer();
          const head = new Uint8Array(buf.slice(0, 4));
          const isWasm = head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d;
          if (!isWasm) {
            await logToClient(kernelClientId, 'error', `wasm invalid (${wasmUrl}): magic=${Array.from(head).map((b) => b.toString(16).padStart(2, '0')).join('') || 'none'}`);
          } else {
            wasmModule = await WebAssembly.compile(buf);
          }
        }
      } catch (e) {
        await logToClient(kernelClientId, 'error', `wasm fetch error (${wasmUrl}): ${e.message || e}`);
      }
      if (!wasmModule) {
        try {
          const buf = await rpc('fs.readFile', { path: opfsVendorWasm, asText: false }, kernelClientId);
          if (buf) {
            wasmModule = await WebAssembly.compile(buf);
            await logToClient(kernelClientId, 'system', `esbuild wasm loaded from OPFS (${opfsVendorWasm})`);
          }
        } catch (e) {
          await logToClient(kernelClientId, 'error', `opfs wasm failed (${opfsVendorWasm}): ${e.message || e}`);
        }
      }
      const init = { worker: false };
      if (wasmModule) init.wasmModule = wasmModule;
      else init.wasmURL = wasmUrl;
      await esbuild.initialize(init);
      return esbuild;
    } catch (e) {
      await logToClient(kernelClientId, 'error', `esbuild init failed: ${e.message || e}`);
      esbuild = null;
      return null;
    }
  })();
  return esbuildInit;
}

async function transformModuleInline({ code, loader, sourcefile }) {
  const mod = await ensureEsbuild();
  if (!mod) {
    return null;
  }
  const result = await mod.transform(code || '', {
    loader,
    sourcemap: 'inline',
    format: 'esm',
    platform: 'browser',
    sourcefile
  });
  return { code: result.code || '', map: result.map || '' };
}

async function bundleDepInline({ entryPath, appRoot, clientId }) {
  const mod = await ensureEsbuild();
  if (!mod) return null;

  const plugin = {
    name: 'opfs-resolver',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        const candidate = normalizeFsPath(args.path);
        if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
          return { path: candidate, external: true };
        }
        if (candidate.startsWith('.') || candidate.startsWith('/')) {
          const resolved = candidate.startsWith('.')
            ? joinPath(args.resolveDir || '/', candidate)
            : normalizePath(candidate);
          return { path: resolved, namespace: 'opfs' };
        }
        if (candidate.startsWith('ops:') || candidate.startsWith('opfs:') || candidate.startsWith('file://')) {
          const resolved = normalizeFsPath(candidate);
          return { path: normalizePath(resolved), namespace: 'opfs' };
        }
        const resolvedBare = await resolveBare(candidate, appRoot, clientId);
        return { path: resolvedBare.entryPath || resolvedBare, namespace: 'opfs' };
      });

      build.onLoad({ filter: /.*/, namespace: 'opfs' }, async (args) => {
        const normalized = normalizeFsPath(args.path);
        try {
          const s = await stat(normalized, clientId);
          if (!s || !s.exists || s.isDir) {
            await logToClient(clientId, 'error', `opfs-resolver stat miss: ${normalized}`);
          }
        } catch (e) {
          await logToClient(clientId, 'error', `opfs-resolver stat error: ${normalized} (${e.message || e})`);
        }
        const contents = await readFile(normalized, true, clientId);
        const loader = guessLoader(normalized);
        return { contents, loader, resolveDir: dirname(normalized) };
      });
    }
  };

  const result = await mod.build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    sourcemap: false,
    plugins: [plugin]
  });

  const output = result.outputFiles && result.outputFiles[0];
  if (!output) throw new Error('Bundle failed: no output');
  return { code: output.text || '' };
}

async function bundleDep(depInfo, clientId) {
  if (depBundles.has(depInfo.key)) return depBundles.get(depInfo.key);
  if (depInflight.has(depInfo.key)) return depInflight.get(depInfo.key);
  const promise = (async () => {
    const result = await toolCall('bundle', {
      entryPath: depInfo.entryPath,
      appRoot: depInfo.appRoot,
      clientId
    });
    depBundles.set(depInfo.key, result.code);
    try {
      await rpc('fs.writeFile', { path: `${DEP_CACHE_DIR}/${depInfo.key}`, content: result.code }, clientId);
    } catch {
      // Ignore cache write failures
    }
    return result.code;
  })();
  depInflight.set(depInfo.key, promise);
  try {
    const out = await promise;
    depInflight.delete(depInfo.key);
    return out;
  } catch (e) {
    depInflight.delete(depInfo.key);
    throw e;
  }
}

function contentTypeFor(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.html')) return 'text/html';
  if (lower.endsWith('.css')) return 'text/css';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/apps/')) {
    event.respondWith(handleAppRequest(event, url));
    return;
  }
  if (url.pathname.startsWith('/@deps/')) {
    event.respondWith(handleDepsRequest(event, url));
  }
});

async function handleDepsRequest(event, url) {
  const key = url.pathname.replace('/@deps/', '');
  const info = depRegistry.get(key);
  if (!info) {
    await logToClient(event.clientId, 'error', `Dep not registered: ${key}`);
    return new Response(`Dependency not registered: ${key}`, { status: 404 });
  }
  try {
    let code = depBundles.get(key);
    if (!code) {
      code = await bundleDep(info, event.clientId);
    }
    return new Response(code, {
      status: 200,
      headers: { 'Content-Type': 'application/javascript' }
    });
  } catch (e) {
    await logToClient(event.clientId, 'error', `Dep bundle failed for ${key}: ${e.message || e}`);
    return new Response(`Dep bundle failed: ${e.message || e}`, { status: 500 });
  }
}

async function handleAppRequest(event, url) {
  const path = url.pathname;
  const appRoot = '/' + path.split('/').filter(Boolean).slice(0, 2).join('/');
  let resolvedPath = path;
  if (!/\.[a-zA-Z0-9]+$/.test(path) && !path.endsWith('/')) {
    const withExt = await resolveWithExtensions(path, event.clientId);
    if (withExt) resolvedPath = withExt;
  }

  if (path.endsWith('/')) {
    return fetch(event.request);
  }

  await logToClient(event.clientId, 'system', `fetch ${path} -> ${resolvedPath}`);

  if (resolvedPath.endsWith('.html')) {
    try {
      const html = await readFile(resolvedPath, true, event.clientId);
      return new Response(html || '', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      });
    } catch {
      await logToClient(event.clientId, 'error', `HTML not found: ${path}`);
      const fallback = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${appRoot.split('/').pop() || 'App'}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${appRoot}/src/main.tsx"></script>
  </body>
</html>
`;
      return new Response(fallback, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
  }

  if (resolvedPath.endsWith('.css')) {
    try {
      const css = await readFile(resolvedPath, true, event.clientId);
      const dest = event.request.destination || '';
      const accept = (event.request.headers && event.request.headers.get('Accept')) || '';
      const isStylesheet = dest === 'style' || (accept.includes('text/css') && !accept.includes('application/javascript'));
      await logToClient(event.clientId, 'system', `css ${resolvedPath} dest=${dest || 'none'} accept=${accept || 'none'} wrap=${!isStylesheet}`);
      if (!isStylesheet) {
        const js = [
          "const style = document.createElement('style');",
          "style.setAttribute('data-oapp-css', " + JSON.stringify(resolvedPath) + ");",
          "style.textContent = " + JSON.stringify(css || '') + ";",
          "document.head.appendChild(style);",
          "export default style;"
        ].join("\n");
        return new Response(js, {
          status: 200,
          headers: { 'Content-Type': 'application/javascript' }
        });
      }
      return new Response(css || '', {
        status: 200,
        headers: { 'Content-Type': 'text/css' }
      });
    } catch {
      await logToClient(event.clientId, 'error', `CSS not found: ${path}`);
      return new Response('Not Found', { status: 404 });
    }
  }

  if (/\.(ts|tsx|js|jsx|mjs)$/.test(resolvedPath)) {
    try {
      if (!DISABLE_MODULE_CACHE && moduleCache.has(resolvedPath)) {
        let cached = moduleCache.get(resolvedPath) || '';
        const cachedSpecs = findImports(cached);
        const needsRewrite = cachedSpecs.some((spec) => {
          if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('http')) return false;
          if (spec.startsWith('/@deps/')) return false;
          return true;
        });
        if (needsRewrite) {
          const mapping = new Map();
          for (const spec of cachedSpecs) {
            if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('http')) continue;
            if (spec.startsWith('/@deps/')) continue;
            const depUrl = await ensureDep(spec, appRoot, event.clientId);
            mapping.set(spec, depUrl);
          }
          cached = rewriteImports(cached, mapping);
          moduleCache.set(resolvedPath, cached);
          await logToClient(event.clientId, 'system', `cache hit ${resolvedPath} (rewrote bare imports)`);
        } else {
          await logToClient(event.clientId, 'system', `cache hit ${resolvedPath}`);
        }
        return new Response(cached, {
          status: 200,
          headers: { 'Content-Type': 'application/javascript' }
        });
      }
      const code = await readFile(resolvedPath, true, event.clientId);
      const loader = guessLoader(resolvedPath);
      const result = await transformModule(code || '', loader, resolvedPath, event.clientId);
      await logToClient(event.clientId, 'system', `transform ${resolvedPath} loader=${loader}`);
      const specs = findImports(result.code || '');
      await logToClient(event.clientId, 'system', `imports ${resolvedPath}: ${specs.join(', ')}`);
      const mapping = new Map();
      for (const spec of specs) {
        if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('http')) continue;
        const depUrl = await ensureDep(spec, appRoot, event.clientId);
        mapping.set(spec, depUrl);
      }
      let rewritten = rewriteImports(result.code || '', mapping);
      rewritten = rewriteRelativeImports(rewritten, resolvedPath, event.clientId);
      if (!DISABLE_MODULE_CACHE) {
        moduleCache.set(resolvedPath, rewritten);
      }
      return new Response(rewritten, {
        status: 200,
        headers: { 'Content-Type': 'application/javascript' }
      });
    } catch (e) {
      await logToClient(event.clientId, 'error', `Transform failed for ${path}: ${e.message || e}`);
      return new Response(`Transform failed: ${e.message || e}`, { status: 500 });
    }
  }

  const isText = isTextPath(resolvedPath);
  try {
    const data = await readFile(resolvedPath, isText, event.clientId);
    return new Response(data, {
      status: 200,
      headers: { 'Content-Type': contentTypeFor(resolvedPath) }
    });
  } catch {
    await logToClient(event.clientId, 'error', `File not found: ${path}`);
    return new Response('Not Found', { status: 404 });
  }
}
