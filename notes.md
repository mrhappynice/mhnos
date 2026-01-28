

## 0) What we are doing to the OS (the big picture)

### What you have today

- Apps are launched via the `oapp` shell command that reads `/path/index.html`, `/path/styles.css`, `/path/app.js` from OPFS and injects them into an iframe via `srcdoc`.

- If `app.js` uses `import`/`export`, you fall into a custom “module graph + Babel standalone” loader injected into the iframe.

- Your kernel owns OPFS and exposes FS operations to workers via message-passing syscalls (ex: `SYSCALL_FS_READ`, `SYSCALL_FS_WRITE`).

- You already have an in-OS `npm install` that downloads packages and lays them out into `node_modules`, and in global mode it installs to `/usr/lib/node_modules` and links `/usr/bin/*.js` shims.

### What we’re changing

We are switching to a **Vite-like runtime**:

1. **Apps become real URLs** (same-origin), not `srcdoc`:
- `oapp` opens an iframe at `/apps/<name>/index.html` (URL), not an inlined document.
2. A **Service Worker becomes your “dev server”**:
- It intercepts `fetch` for `/apps/**` (and optionally `/@fs/**`, `/@id/**`, `/@vite/**` style internal routes).

- It loads source files from OPFS via **RPC to the kernel** (because kernel owns OPFS). This matches your syscall model.

- It transforms TS/TSX/JSX and rewrites imports on-demand using **esbuild-wasm in a tooling worker**.
3. We implement a real **resolver**:
- Resolve relative/absolute imports from the app directory.

- Resolve **bare imports** (like `react`, `react-dom/client`) from `/apps/<name>/node_modules` first, then fall back to `/usr/lib/node_modules` (global install location you already use).

- Handle `package.json` entry selection and `exports` enough to run React and common libs.

- Prebundle non-ESM (CJS) deps to ESM (Vite-style “deps optimization”).
4. Your existing “Node-like runtime workers” (CJS `require`, express servers, etc.) remain separate:
- That system lives in `src/runtime/worker.js` with polyfills and ESM.sh imports for node-ish APIs.

- The new Vite-like pipeline is **for browser apps** running in the iframe.

---

## 1) New app layout (definitive)

You said you want:

- `/apps/<name>/`

- entry: `/apps/<name>/src/main.tsx`

So we standardize:

```
/apps/<name>/
  index.html
  src/
    main.tsx
  package.json          (optional, for deps)
/apps/<name>/node_modules/   (optional, per-app deps)
/usr/lib/node_modules/       (global deps, from npm -g)
```

`/apps/<name>/index.html` should look like Vite:

```html
<div id="root"></div>
<script type="module" src="/apps/<name>/src/main.tsx"></script>
```

Key point: **browser can’t execute TSX**, so the SW will intercept the request to `main.tsx` and return **compiled JS**.

---

## 2) Change `oapp`: stop srcdoc, load same-origin URL

Today `oapp` reads files and builds an iframe `srcdoc`.  
We replace that with:

- `iframe.src = "/apps/<name>/index.html"` (or the path argument’s `index.html` but under `/apps` you’re standardizing)

- This must be **same origin** so the SW controls module loading.

You do **not** need to sandbox the iframe to make this work. If you add sandboxing later, you must include at least:

- `sandbox="allow-scripts allow-same-origin"`  
  …but for now, “just make it work” ⇒ no sandbox.

---

## 3) Install + register the Service Worker from the kernel boot

Your OS boots from `index.html` → `src/kernel/main.js`.

Add SW registration early in kernel startup:

- `navigator.serviceWorker.register('/mhnos-sw.js', { scope: '/' })`

- Wait for `ready` before launching Vite-style apps.

Important constraints:

- SW script must be served from the **network origin** path (e.g. `/mhnos-sw.js`), not from OPFS.

- You can still *also* copy it into OPFS for editing, but the registered script URL must be fetchable by the browser as a normal asset.

---

## 4) FS RPC: Service Worker ↔ Kernel (message passing)

You already have kernel syscall handling for FS read/write/list in the message handler.  
And kernel-side OPFS access is implemented in `src/kernel/fs.js`.

### Definitive model

- **SW never touches OPFS directly**

- SW uses `postMessage` to the controlled page (kernel) and kernel responds with the file bytes/text

- This is exactly like your existing worker→kernel syscalls, just inverted direction.

### Required additions

1. In kernel (`src/kernel/main.js`):
   
   - Add a “SW RPC server” that listens for messages from `navigator.serviceWorker` / `message` events coming from the SW.
   
   - Implement at least:
     
     - `fs.readFile(path, asText)`
     
     - `fs.stat(path)` (or a lightweight “exists + isDir”)
     
     - `fs.listDir(path)` (directory listing)
   
   - Respond with `{id, ok, data | error}`.

2. In SW:
   
   - Maintain a request map `pending[id] = resolve/reject`
   
   - `rpc('fs.readFile', { path, asText })`

This is consistent with your kernel being the single authority over OPFS and aligns with your existing syscall patterns.

---

## 5) Service Worker responsibilities (the “Vite dev server”)

### A. Intercept app requests

In `fetch` handler:

If URL matches:

- `/apps/<name>/index.html` → serve the file from OPFS (or generate a default if missing)

- `/apps/<name>/src/**` → read source, transform if needed, return JS with correct headers

- `/apps/<name>/assets/**` (optional) → serve raw bytes

- `/@deps/**` (or your chosen prefix) → serve prebundled ESM dependency outputs from cache

### B. Transform pipeline (what happens on module requests)

For any JS/TS/TSX/JSX module request:

1. Read file from OPFS via RPC.

2. Send to tooling worker (esbuild-wasm) to:
   
   - transform TS/TSX/JSX to JS
   
   - output `format: 'esm'`, `platform: 'browser'`
   
   - generate sourcemap (optional, but recommended)

3. Rewrite import specifiers in the output:
   
   - relative and absolute stay mostly as-is
   
   - bare imports are rewritten to your internal dep route, e.g.:
     
     - `react` → `"/@deps/react.js?v=<hash>"`
     
     - `react-dom/client` → `"/@deps/react-dom_client.js?v=<hash>"`

4. Return transformed JS.

### C. Module graph + caching

Vite’s speed is caching.  
In your SW you should cache on:

- `{path, mtime/version}` → transformed output

- dependency prebundles keyed by `{packageName, version, entry}`

Because OPFS doesn’t give you cheap watchers, do this:

- When your OS editor writes a file, kernel emits a `fileChanged(path)` event to SW clients.

- SW clears caches for that path and triggers reload/HMR.

Your kernel already controls writes via `fs.writeFile`.  
So you can reliably notify SW after successful writes.

---

## 6) Tooling worker (esbuild-wasm) responsibilities

This worker does the heavy lifting so SW stays responsive.

### A. Load esbuild-wasm

- Bundle `esbuild-wasm` assets as static files (network-served) so they’re same-origin.

- Tooling worker initializes esbuild once and keeps it warm.

### B. Provide two APIs

1. `transformModule({ code, loader, sourcefile })`
   
   - loader based on extension: `ts`, `tsx`, `jsx`, `js`
   
   - returns `{ code, map, warnings }`

2. `prebundleDep({ entryPath, resolveDir })`
   
   - esbuild “bundle: true”
   
   - output a single ESM file for that dependency
   
   - externalize things you want to keep separate (optional at first)
   
   - returns bundled ESM code + hash

---

## 7) The resolver (this is the “biggest issue” and it’s not “npm install”)

You asked: “is this like regular npm install?”  
**No.** They’re related, but different responsibilities:

### npm install (you already have)

- Downloads tarballs

- Writes files to `node_modules`

- (optionally) links `/usr/bin` shims for `bin` entries  
  That’s installation/layout.

### Resolver (what we’re building)

Given an import specifier, figure out:

- **which file** it refers to

- **what URL** the browser should request

- how to handle package entrypoints (`package.json` fields, `exports`, etc.)

This is runtime/module resolution, not package installation.

### Definitive resolution rules for your OS (start here)

When resolving an import from a module at `/apps/<name>/src/...`:

#### 1) Relative imports (`./`, `../`)

- Resolve against the importer directory.

- Try exact file, then try extension variants:
  
  - `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`

- If it’s a directory, try:
  
  - `<dir>/index.tsx`, `<dir>/index.ts`, `<dir>/index.jsx`, `<dir>/index.js`

#### 2) Absolute imports starting with `/`

- Treat as absolute OPFS paths (same origin).

- Same extension/index rules as above.

#### 3) Bare imports (`react`, `react-dom/client`, `lodash`)

- Split into `pkgName` and `subpath`:
  
  - `react-dom/client` ⇒ pkg=`react-dom`, subpath=`client`
  
  - `@scope/pkg/subpath` ⇒ pkg=`@scope/pkg`, subpath=`subpath`

- Find the package root directory by searching in order:
  
  1. `/apps/<name>/node_modules/<pkgName>`
  
  2. `/usr/lib/node_modules/<pkgName>` (your global install location)

- Read `<pkgRoot>/package.json`

- Choose entry:
  
  - Prefer `exports` if present (you can implement a minimal subset first)
  
  - Else prefer `browser` then `module` then `main`

- If subpath exists (`react-dom/client`):
  
  - If `exports` supports it, use it
  
  - Else fall back to `<pkgRoot>/<subpath>` with extension/index probing

#### 4) Decide whether to prebundle

If the resolved file is:

- ESM already (`.mjs`, or package `"type":"module"`, or contains `export`/`import`) → serve/transform directly.

- CJS (`require`, `module.exports`, many `.js` in npm) → **prebundle to ESM** and serve from `/@deps/...`.

That’s how you get React and friends working consistently.

---

## 8) Dependency prebundling cache layout (Vite-like “optimize deps”)

Create a cache directory in OPFS, e.g.:

```
/usr/cache/vite/deps/
  react@18.2.0.js
  react-dom@18.2.0_client.js
  scheduler@...js
  dep-manifest.json
```

Flow:

1. First time SW sees bare import `react`:
   
   - resolve to installed package file
   
   - tooling worker bundles to ESM
   
   - write output to `/usr/cache/vite/deps/...`

2. SW rewrites imports to `/@deps/react@18.2.0.js?v=<hash>`

3. Next load hits cache.

This is the piece that replaces your current “Babel standalone + module graph JSON injected into srcdoc” approach.

---

## 9) Aligning the rest of the OS (what changes ripple outward)

### A) `oapp build` and “wrapper created”

Your shell currently can create a “Vite wrapper” but explicitly says it’s “no Vite build”.  
After this migration, that message becomes obsolete. `oapp build` should instead mean one of:

- **Option 1 (recommended first):** “build” = ensure the app has the new layout (`index.html`, `src/main.tsx`) and maybe installs deps.

- **Option 2 (later):** “build” = produce a static production bundle into `/apps/<name>/dist/` using esbuild bundling.

But do not keep the old “srcdoc module loader” path; we are removing that.

### B) App Builder output format

Your docs show App Builder creates apps like:

```
/apps/todo/
  index.html
  styles.css
  app.js
```

You must update it to generate:

```
/apps/todo/
  index.html
  src/main.tsx
  src/App.tsx
  src/styles.css (optional)
```

…and `index.html` should reference `/apps/todo/src/main.tsx` as a module.

### C) Kernel FS syscalls remain authoritative

Your kernel currently handles `SYSCALL_FS_READ/WRITE/LIST` for processes.  
We are adding **one more consumer** of the same concept: the Service Worker (via a parallel RPC channel).

### D) Node-like process runtime stays separate

Your runtime worker imports `memfs`, `buffer`, and various Node stdlib shims via esm.sh.  
Don’t mix that into the browser-app pipeline. Browser apps should run as browser apps (ESM), not as Node-polyfilled workers.

---

## 10) Minimum implementation checklist (do these in order)

### Phase 1 — Make one TSX React app run via SW

1. Add `/mhnos-sw.js` and register it from kernel boot.

2. Implement kernel↔SW RPC for `readFile`, `listDir`, `stat/exists`.
   
   - Use OPFS implementation you already have in `src/kernel/fs.js`.

3. Modify `oapp` to open iframe by URL (same origin), not `srcdoc`.

4. SW: intercept `/apps/<name>/index.html` and `/apps/<name>/src/main.tsx`

5. Tooling worker: esbuild-wasm `transform` for TSX.

6. Hardcode bare import rewriting just for:
   
   - `react`
   
   - `react-dom/client`

7. Install React into `/usr/lib/node_modules` (global) using your existing npm install path.

At this point, a simple app that imports React should render.

### Phase 2 — Real resolver + prebundling

8. Implement full bare-import resolver rules (app-local node_modules then global).

9. Implement `package.json` entry selection and basic `exports` handling.

10. Implement CJS detection + prebundle to `/usr/cache/vite/deps/`.

### Phase 3 — Live reload (Vite “feel”)

11. Kernel emits `fileChanged(path)` after successful writes.

12. SW broadcasts “reload” to app iframes (simple full reload is fine to start).

---




