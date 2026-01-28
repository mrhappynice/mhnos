// mhnos-vite-worker.js
let esbuild = null;
let esbuildInit = null;

const fsPending = new Map();
let fsReqId = 1;

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === 'tool_request') {
    const { id, action, payload } = msg;
    try {
      if (action === 'transform') {
        const result = await transformModule(payload);
        self.postMessage({ type: 'tool_response', id, ok: true, result });
        return;
      }
      if (action === 'bundle') {
        const result = await bundleDep(payload);
        self.postMessage({ type: 'tool_response', id, ok: true, result });
        return;
      }
      self.postMessage({ type: 'tool_response', id, ok: false, error: `unknown action: ${action}` });
    } catch (e) {
      self.postMessage({ type: 'tool_response', id, ok: false, error: e.message || String(e) });
    }
    return;
  }
  if (msg.type === 'fs_read_response' || msg.type === 'fs_stat_response') {
    const pending = fsPending.get(msg.id);
    if (pending) {
      fsPending.delete(msg.id);
      msg.ok ? pending.resolve(msg.data) : pending.reject(new Error(msg.error || 'fs rpc failed'));
    }
  }
};

async function ensureEsbuild() {
  if (esbuildInit) return esbuildInit;
  esbuildInit = (async () => {
    try {
      const baseUrl = new URL('.', self.location.href).toString();
      const vendorJs = new URL('vendor/esbuild-wasm.js', baseUrl).toString();
      const vendorWasm = new URL('vendor/esbuild-wasm.wasm', baseUrl).toString();
      const opfsVendorJs = '/vendor/esbuild-wasm.js';
      const opfsVendorWasm = '/vendor/esbuild-wasm.wasm';
      if (!self.esbuild) {
        try {
          importScripts(vendorJs);
        } catch (e) {
          // Fallback to OPFS copy when network assets aren't available.
          const script = await fsRead(opfsVendorJs, true, null);
          if (script) {
            const fn = new Function(script);
            fn();
          }
        }
      }
      esbuild = self.esbuild || null;
      if (!esbuild) return null;
      let wasmModule = null;
      try {
        const res = await fetch(vendorWasm, { cache: 'no-store' });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          wasmModule = await WebAssembly.compile(buf);
        }
      } catch {}
      if (!wasmModule) {
        try {
          const buf = await fsRead(opfsVendorWasm, false, null);
          if (buf) wasmModule = await WebAssembly.compile(buf);
        } catch {}
      }
      const init = { worker: false };
      if (wasmModule) init.wasmModule = wasmModule;
      else init.wasmURL = vendorWasm;
      await esbuild.initialize(init);
      return esbuild;
    } catch (e) {
      esbuild = null;
      return null;
    }
  })();
  return esbuildInit;
}

function fsRpc(type, payload) {
  const id = fsReqId++;
  const promise = new Promise((resolve, reject) => {
    fsPending.set(id, { resolve, reject });
  });
  self.postMessage({ type, id, ...payload });
  return promise;
}

function normalizeFsPath(path) {
  if (!path) return path;
  if (path.startsWith('ops:')) return path.slice(4);
  if (path.startsWith('opfs:')) return path.slice(5);
  if (path.startsWith('file://')) return path.replace('file://', '');
  return path;
}

async function fsRead(path, asText, clientId) {
  return await fsRpc('fs_read', { path: normalizeFsPath(path), asText: !!asText, clientId });
}

async function fsStat(path, clientId) {
  return await fsRpc('fs_stat', { path: normalizeFsPath(path), clientId });
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

function pickExportTarget(target) {
  if (!target) return null;
  if (typeof target === 'string') return target;
  if (typeof target === 'object') {
    return target.import || target.browser || target.default || target.module || target.require || null;
  }
  return null;
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
    const s = await fsStat(candidate, clientId);
    if (s && s.exists && !s.isDir) return candidate;
  }
  const dirStat = await fsStat(path, clientId);
  if (dirStat && dirStat.exists && dirStat.isDir) {
    const indexCandidates = [
      `${path}/index.tsx`,
      `${path}/index.ts`,
      `${path}/index.jsx`,
      `${path}/index.js`,
      `${path}/index.mjs`
    ];
    for (const candidate of indexCandidates) {
      const s = await fsStat(candidate, clientId);
      if (s && s.exists && !s.isDir) return candidate;
    }
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

  const appStat = await fsStat(appNodeModules, clientId);
  const appExists = appStat && appStat.exists && appStat.isDir;

  const tryResolveAt = async (pkgRoot) => {
    const pkgRootStat = await fsStat(pkgRoot, clientId);
    if (!pkgRootStat || !pkgRootStat.exists) return null;
    let pkgJson = {};
    const pkgJsonPath = `${pkgRoot}/package.json`;
    try {
      const pkgText = await fsRead(pkgJsonPath, true, clientId);
      pkgJson = JSON.parse(pkgText || '{}');
    } catch {
      pkgJson = {};
    }
    const entryPath = await resolvePackageEntry(pkgRoot, pkgJson, subpath, clientId);
    if (!entryPath) return null;
    const entryStat = await fsStat(entryPath, clientId);
    if (!entryStat || !entryStat.exists || entryStat.isDir) return null;
    return entryPath;
  };

  let resolved = null;
  if (appExists) {
    resolved = await tryResolveAt(appNodeModules);
  }
  if (!resolved) {
    resolved = await tryResolveAt(globalNodeModules);
  }
  if (resolved) return resolved;

  const fileStat = await fsStat(globalSingleFile, clientId);
  if (fileStat && fileStat.exists && !fileStat.isDir) {
    return globalSingleFile;
  }
  throw new Error(`Package not found: ${pkgName}`);
}

function guessLoader(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts')) return 'ts';
  if (lower.endsWith('.jsx')) return 'jsx';
  if (lower.endsWith('.json')) return 'json';
  return 'js';
}

async function transformModule({ code, loader, sourcefile }) {
  const mod = await ensureEsbuild();
  if (!mod) {
    if (loader === 'js' || loader === 'jsx') {
      return { code: code || '', map: '' };
    }
    throw new Error('esbuild-wasm not available for TS/TSX transforms');
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

async function bundleDep({ entryPath, appRoot, clientId }) {
  const mod = await ensureEsbuild();
  if (!mod) throw new Error('esbuild-wasm not available for bundling');
  const entry = normalizeFsPath(entryPath);

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
        return { path: resolvedBare, namespace: 'opfs' };
      });

      build.onLoad({ filter: /.*/, namespace: 'opfs' }, async (args) => {
        const normalized = normalizeFsPath(args.path);
        const contents = await fsRead(normalized, true, clientId);
        const loader = guessLoader(normalized);
        return { contents, loader, resolveDir: dirname(normalized) };
      });
    }
  };

  const result = await mod.build({
    entryPoints: [entry],
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
