import * as fs from "/src/kernel/fs.js";

const preview = document.getElementById("preview");
const overlay = document.getElementById("overlay");
const overlayPre = overlay.querySelector("pre");

let channelId = null;
let parentOrigin = "*";
let lastHtml = "";
let lastModules = {};
let ready = false;
let pendingCompile = null;
let hasCompiled = false;
let compileInFlight = false;
let queuedCompile = null;

const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
];

const INDEX_EXTENSIONS = [
  "/index.tsx",
  "/index.ts",
  "/index.jsx",
  "/index.js",
  "/index.mjs",
  "/index.cjs",
];

function post(message) {
  const payload = { codesandbox: true, ...message };
  if (channelId !== null) payload.$id = channelId;
  window.parent.postMessage(payload, parentOrigin);
}

function normalizePath(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  const stack = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return "/" + stack.join("/");
}

function dirname(path) {
  if (!path || path === "/") return "/";
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

function guessLoader(path) {
  const lower = path.toLowerCase();
  if (/(\.png|\.jpe?g|\.gif|\.webp|\.avif|\.ico|\.bmp)$/.test(lower)) return "dataurl";
  if (lower.endsWith(".svg")) return "text";
  if (/(\.woff2?|\.ttf|\.otf|\.eot)$/.test(lower)) return "dataurl";
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts")) return "ts";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".css")) return "css";
  return "js";
}

function resolveInMemory(path, modules) {
  if (modules[path]) return path;
  for (const ext of EXTENSIONS) {
    const candidate = path + ext;
    if (modules[candidate]) return candidate;
  }
  for (const ext of INDEX_EXTENSIONS) {
    const candidate = path + ext;
    if (modules[candidate]) return candidate;
  }
  return null;
}

function parsePackageName(spec) {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
  }
  return spec.split("/")[0];
}

function parseSubpath(spec, pkgName) {
  if (spec === pkgName) return "";
  if (spec.startsWith(pkgName + "/")) return spec.slice(pkgName.length + 1);
  return "";
}

function pickExportTarget(target) {
  if (!target) return null;
  if (typeof target === "string") return target;
  if (typeof target === "object") {
    return (
      target.import || target.browser || target.default || target.module || target.require || null
    );
  }
  return null;
}

function resolvePackageEntry(pkgJson, subpath) {
  let entryRel = null;
  const exportsField = pkgJson && pkgJson.exports;
  if (exportsField) {
    if (subpath) {
      const key = `./${subpath}`;
      entryRel = pickExportTarget(exportsField[key]);
    } else {
      entryRel = pickExportTarget(exportsField["."] || exportsField);
    }
  }
  if (!entryRel) {
    if (subpath) entryRel = subpath;
    else entryRel = pkgJson.browser || pkgJson.module || pkgJson.main || "index.js";
  }
  return entryRel || null;
}

function resolveBareInMemory(spec, modules) {
  const pkgName = parsePackageName(spec);
  const subpath = parseSubpath(spec, pkgName);
  const pkgRoot = `/node_modules/${pkgName}`;
  const pkgJsonPath = `${pkgRoot}/package.json`;
  let pkgJson = {};
  if (!modules[pkgJsonPath]) return null;
  try {
    pkgJson = JSON.parse(modules[pkgJsonPath].code || "{}");
  } catch {}
  const entryRel = resolvePackageEntry(pkgJson, subpath);
  if (!entryRel) return null;
  const fullPath = normalizePath(`${pkgRoot}/${entryRel}`);
  const resolved = resolveInMemory(fullPath, modules);
  return resolved || null;
}

async function resolveWithExtensionsFs(path) {
  const candidates = [path, ...EXTENSIONS.map((ext) => path + ext)];
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate);
    if (stat && stat.success && stat.data && stat.data.exists && !stat.data.isDir) return candidate;
  }
  const dirStat = await fs.stat(path);
  if (dirStat && dirStat.success && dirStat.data && dirStat.data.exists && dirStat.data.isDir) {
    for (const ext of INDEX_EXTENSIONS) {
      const candidate = path + ext;
      const s = await fs.stat(candidate);
      if (s && s.success && s.data && s.data.exists && !s.data.isDir) return candidate;
    }
  }
  return null;
}

async function resolveBareFromFs(spec) {
  const pkgName = parsePackageName(spec);
  const subpath = parseSubpath(spec, pkgName);
  const pkgRoot = `/usr/lib/node_modules/${pkgName}`;
  const pkgStat = await fs.stat(pkgRoot);
  if (!pkgStat || !pkgStat.success || !pkgStat.data || !pkgStat.data.exists) return null;

  let pkgJson = {};
  try {
    const res = await fs.readFile(`${pkgRoot}/package.json`, true);
    if (res && res.success && res.data) pkgJson = JSON.parse(res.data);
  } catch {}

  const entryRel = resolvePackageEntry(pkgJson, subpath);
  if (!entryRel) return null;
  const fullPath = normalizePath(`${pkgRoot}/${entryRel}`);
  const resolved = await resolveWithExtensionsFs(fullPath);
  return resolved || null;
}

async function ensureEsbuild() {
  if (window.__osEsbuild) return window.__osEsbuild;
  if (!window.esbuild) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/vendor/esbuild-wasm.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Failed to load /vendor/esbuild-wasm.js"));
      document.head.appendChild(script);
    });
  }
  const esbuild = window.esbuild;
  if (!esbuild) throw new Error("esbuild not available on window");
  await esbuild.initialize({ wasmURL: "/vendor/esbuild-wasm.wasm", worker: false });
  window.__osEsbuild = esbuild;
  return esbuild;
}

function normalizeModules(rawModules) {
  const out = {};
  for (const [path, mod] of Object.entries(rawModules || {})) {
    const normalized = normalizePath(path);
    const code = typeof mod?.code === "string" ? mod.code : mod?.content || "";
    out[normalized] = { code };
  }
  return out;
}

function findHtml(modules) {
  if (modules["/public/index.html"]) return "/public/index.html";
  if (modules["/index.html"]) return "/index.html";
  const publicIndex = Object.keys(modules).find((p) => p.endsWith("/public/index.html"));
  if (publicIndex) return publicIndex;
  const index = Object.keys(modules).find((p) => p.endsWith("/index.html"));
  return index || null;
}

function findEntryFromHtml(html, htmlPath) {
  if (!html) return null;
  const match = html.match(/<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/i) ||
    html.match(/<script[^>]*src=["']([^"']+)["']/i);
  if (!match) return null;
  const src = match[1];
  if (src.startsWith("http://") || src.startsWith("https://")) return null;
  const base = dirname(htmlPath || "/");
  return normalizePath(src.startsWith("/") ? src : `${base}/${src}`);
}

function findEntry(modules) {
  if (modules["/package.json"]) {
    try {
      const pkg = JSON.parse(modules["/package.json"].code || "{}");
      if (pkg.main) return normalizePath(pkg.main);
      if (pkg.module) return normalizePath(pkg.module);
    } catch {}
  }

  const htmlPath = findHtml(modules);
  if (htmlPath) {
    const entry = findEntryFromHtml(modules[htmlPath]?.code || "", htmlPath);
    if (entry) return entry;
  }

  const candidates = [
    "/src/main.tsx",
    "/src/index.tsx",
    "/src/main.ts",
    "/src/index.ts",
    "/src/main.jsx",
    "/src/index.jsx",
    "/src/main.js",
    "/src/index.js",
    "/index.tsx",
    "/index.ts",
    "/index.jsx",
    "/index.js",
  ];
  for (const candidate of candidates) {
    if (modules[candidate]) return candidate;
  }

  const firstJs = Object.keys(modules).find((p) => /\.(t|j)sx?$/.test(p));
  return firstJs || null;
}

function injectAfter(html, markerRegex, injection) {
  const match = html.match(markerRegex);
  if (!match) return html + injection;
  const index = match.index + match[0].length;
  return html.slice(0, index) + injection + html.slice(index);
}

function stripLocalAssets(html) {
  let out = html;
  // Remove local module scripts (keep external URLs)
  out = out.replace(
    /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
    (match, src) => {
      if (/^https?:\/\//i.test(src)) return match;
      return "";
    }
  );
  // Remove local stylesheet links (keep external URLs)
  out = out.replace(
    /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi,
    (match, href) => {
      if (/^https?:\/\//i.test(href) || href.includes("fonts.googleapis")) return match;
      return "";
    }
  );
  return out;
}

function buildHtml(template, cssText, jsText, externalResources = []) {
  let html = template || `<!doctype html><html><head><meta charset="utf-8" /></head><body><div id="root"></div></body></html>`;
  html = stripLocalAssets(html);
  const resourceTags = (externalResources || []).map((resource) => {
    if (/\.css(\?|$)/.test(resource) || resource.includes("fonts.googleapis")) {
      return `<link rel="stylesheet" href="${resource}">`;
    }
    return `<script src="${resource}"></script>`;
  }).join("\n");

  const styleTag = `<style>\n${cssText || ""}\n</style>`;
  const scriptTag = `<script type="module">\n${jsText || ""}\n</script>`;

  if (/<head[\s>]/i.test(html)) {
    html = injectAfter(html, /<head[^>]*>/i, `\n${resourceTags}\n${styleTag}`);
  } else {
    html = `<!doctype html><head>${resourceTags}${styleTag}</head>` + html;
  }

  if (/<body[\s>]/i.test(html)) {
    html = injectAfter(html, /<body[^>]*>/i, "\n");
  }

  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, `${scriptTag}\n</body>`);
  } else {
    html += scriptTag;
  }

  return html;
}

async function bundleModules(rawModules, options = {}) {
  const modules = normalizeModules(rawModules);
  const entry = findEntry(modules);
  if (!entry) throw new Error("No entry file found in sandbox");

  const esbuild = await ensureEsbuild();
  const plugin = {
    name: "virtual-fs",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.path.startsWith("http://") || args.path.startsWith("https://")) {
          return { path: args.path, external: true };
        }
        if (args.path.startsWith(".") || args.path.startsWith("/")) {
          const resolved = args.path.startsWith("/")
            ? normalizePath(args.path)
            : normalizePath(`${args.resolveDir || "/"}/${args.path}`);
          const inMemory = resolveInMemory(resolved, modules);
          if (inMemory) return { path: inMemory, namespace: "virtual" };
          const fsResolved = await resolveWithExtensionsFs(resolved);
          if (fsResolved) return { path: fsResolved, namespace: "fs" };
          return { path: resolved, namespace: "virtual" };
        }

        const inMemoryBare = resolveBareInMemory(args.path, modules);
        if (inMemoryBare) return { path: inMemoryBare, namespace: "virtual" };

        const fsResolved = await resolveBareFromFs(args.path);
        if (fsResolved) return { path: fsResolved, namespace: "fs" };

        if (args.path === "react/jsx-runtime") {
          return { path: "virtual:react-jsx-runtime", namespace: "shim" };
        }
        if (args.path === "react/jsx-dev-runtime") {
          return { path: "virtual:react-jsx-dev-runtime", namespace: "shim" };
        }
        if (args.path === "react-dom/client") {
          return { path: "virtual:react-dom-client", namespace: "shim" };
        }

        return { path: args.path, external: true };
      });

      build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => {
        const mod = modules[args.path];
        const loader = guessLoader(args.path);
        return {
          contents: mod ? mod.code : "",
          loader,
          resolveDir: dirname(args.path),
        };
      });

      build.onLoad({ filter: /.*/, namespace: "fs" }, async (args) => {
        const loader = guessLoader(args.path);
        const isBinary = loader === "dataurl";
        const res = await fs.readFile(args.path, !isBinary);
        if (!res || !res.success) throw new Error(`File not found: ${args.path}`);
        const contents = isBinary ? new Uint8Array(res.data || []) : res.data || "";
        return { contents, loader, resolveDir: dirname(args.path) };
      });

      build.onLoad({ filter: /.*/, namespace: "shim" }, (args) => {
        if (args.path === "virtual:react-jsx-runtime") {
          return {
            contents: `
import React from "react";
function wrap(type, props, key) {
  if (key != null) {
    props = Object.assign({}, props, { key });
  }
  return React.createElement(type, props);
}
export const jsx = wrap;
export const jsxs = wrap;
export const jsxDEV = (type, props, key) => wrap(type, props, key);
export const Fragment = React.Fragment;
export default { jsx, jsxs, jsxDEV, Fragment };
            `.trim(),
            loader: "js",
          };
        }
        if (args.path === "virtual:react-jsx-dev-runtime") {
          return {
            contents: `
import React from "react";
function wrap(type, props, key) {
  if (key != null) {
    props = Object.assign({}, props, { key });
  }
  return React.createElement(type, props);
}
export const jsxDEV = (type, props, key) => wrap(type, props, key);
export const Fragment = React.Fragment;
export default { jsxDEV, Fragment };
            `.trim(),
            loader: "js",
          };
        }
        if (args.path === "virtual:react-dom-client") {
          return {
            contents: `
import ReactDOM from "react-dom";
export const createRoot = ReactDOM.createRoot || ReactDOM.unstable_createRoot;
export const hydrateRoot = ReactDOM.hydrateRoot || ReactDOM.unstable_hydrateRoot;
export default ReactDOM;
            `.trim(),
            loader: "js",
          };
        }
        return { contents: "", loader: "js" };
      });
    },
  };

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    sourcemap: false,
    jsx: "automatic",
    outdir: "/__build__",
    define: {
      "process.env.NODE_ENV": "\"development\"",
      "process.env": "{}",
      "process": "{}",
    },
    plugins: [plugin],
  });

  let jsText = "";
  let cssText = "";
  for (const file of result.outputFiles || []) {
    const text =
      typeof file.text === "string" && file.text.length
        ? file.text
        : new TextDecoder().decode(file.contents || new Uint8Array());
    if (file.path.endsWith(".css")) {
      cssText += text || "";
    } else if (file.path.endsWith(".js")) {
      jsText += text || "";
    }
  }

  const htmlPath = findHtml(modules);
  const htmlTemplate = htmlPath ? modules[htmlPath].code : "";
  const html = buildHtml(htmlTemplate, cssText, jsText, options.externalResources || []);

  return { html, entry, modules };
}

async function handleCompile(message) {
  try {
    overlay.style.display = "none";
    post({ type: "start", firstLoad: !hasCompiled });
    post({ type: "status", status: "transpiling" });

    lastModules = message.modules || {};
    const { html } = await bundleModules(lastModules, message);
    lastHtml = html;

    preview.srcdoc = html;
    hasCompiled = true;

    post({ type: "done", compilatonError: false });
    post({ type: "status", status: "done" });
    post({ type: "urlchange", url: "about:srcdoc", back: false, forward: false });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    overlayPre.textContent = error.message || String(error);
    overlay.style.display = "block";

    post({
      type: "action",
      action: "show-error",
      title: "Build error",
      message: error.message || String(error),
      path: "",
      line: 0,
      column: 0,
      payload: {},
    });
    post({ type: "done", compilatonError: true });
  }
}

async function runCompileQueue() {
  if (compileInFlight) return;
  if (!queuedCompile) return;
  compileInFlight = true;
  const next = queuedCompile;
  queuedCompile = null;
  try {
    await handleCompile(next);
  } finally {
    compileInFlight = false;
    if (queuedCompile) runCompileQueue();
  }
}

function requestCompile(message) {
  queuedCompile = message;
  runCompileQueue();
}

window.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "register-frame") {
    channelId = data.id;
    parentOrigin = event.origin || "*";
    ready = true;
    post({ type: "connected" });
    if (pendingCompile) {
      handleCompile(pendingCompile);
      pendingCompile = null;
    }
    return;
  }

  if (!data.codesandbox) return;
  if (channelId !== null && data.$id !== channelId) return;

  switch (data.type) {
    case "compile":
      if (!ready) {
        pendingCompile = data;
      } else {
        requestCompile(data);
      }
      break;
    case "refresh":
      if (lastHtml) preview.srcdoc = lastHtml;
      break;
    case "get-modules":
      post({
        type: "all-modules",
        data: Object.entries(normalizeModules(lastModules)).map(([path, mod]) => ({
          path,
          code: mod.code,
        })),
      });
      break;
    case "get-transpiler-context":
      post({ type: "transpiler-context", data: {} });
      break;
    default:
      break;
  }
});

post({ type: "initialized" });
