import * as fs from '../../kernel/fs.js';
import { runBackupCommand } from '../backup.js';
import { Nano, SettingsApp, FileExplorer, BrowserApp, LauncherApp, CompanionApp, PackeditEditor, TerminalApp } from '../apps.js';
import { PackageManager } from '../npm.js';
import {
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
} from './helpers.js';

export class Shell {
    constructor(os) {
        this.os = os;
        this.input = document.getElementById('cmd-input');
        this.output = document.getElementById('shell-output');
        this.promptStr = document.querySelector('.prompt');
        
        // --- RESTORED MISSING PROPERTIES ---
        this.history = [];
        this.historyIndex = -1;
        // -----------------------------------
        
        this.cwd = '/';
        
        // Initialize Package Manager
        this.npm = new PackageManager(this);

        this.commands = {
            'help': () => {
                this.print("Commands:", 'system');
                this.print("  help                 - show this help", 'system');
                this.print("  clear / cls          - clear the terminal", 'system');
                this.print("  ls [path]            - list files", 'system');
                this.print("  cd [path]            - change directory", 'system');
                this.print("  pwd                  - print working directory", 'system');
                this.print("  mkdir <name>         - create directory", 'system');
                this.print("  rm <path>            - remove file/dir", 'system');
                this.print("  cp [-r] [-f] <src> <dest> - copy file or directory", 'system');
                this.print("  cat <file>           - print file", 'system');
                this.print("  edit <file>          - open editor", 'system');
                this.print("  md <file>            - open markdown preview", 'system');
                this.print("  run <file>           - run a JS process", 'system');
                this.print("  oapp <path>          - launch an oapp", 'system');
                this.print("  oapp init [path]     - scaffold Vite-style oapp", 'system');
                this.print("  oapp build [path]    - bundle oapp to dist/", 'system');
                this.print("  npm install <pkg>    - install npm package", 'system');
                this.print("  upload [folder|-r]   - upload files or folder", 'system');
                this.print("  gitclone <url> [dir] - clone a repo", 'system');
                this.print("  browser              - open browser app", 'system');
                this.print("  files                - open file explorer", 'system');
                this.print("  launcher             - open launcher", 'system');
                this.print("  companion            - open companion app", 'system');
                this.print("  ps                   - list processes", 'system');
                this.print("  kill <pid>           - kill a process", 'system');
                this.print("  backup               - encrypted backup/restore", 'system');
                this.print("  net [status|mode|proxy] - network mode/proxy settings", 'system');
                this.print("  tty [attach|detach|status] - attach shell to a process", 'system');
                this.print("  term <pid>            - open terminal window for a process", 'system');
                this.print("  serverhere            - copy /demos/site/server.js to ./server.js and install express", 'system');
            },
            'clear': () => this.output.innerHTML = '',
            'cls': () => this.output.innerHTML = '',
            
                        'upload': (args) => {
                // Usage: 'upload' for files, 'upload folder' for directories
                const isFolder = args[0] === 'folder' || args[0] === '-r';
                
                const input = document.createElement('input');
                input.type = 'file';
                input.style.display = 'none'; // Keep it hidden
                
                if (isFolder) {
                    input.setAttribute('webkitdirectory', '');
                    input.setAttribute('directory', '');
                } else {
                    input.setAttribute('multiple', '');
                }

                input.onchange = async () => {
                    const files = Array.from(input.files);
                    if (files.length === 0) return;

                    this.print(`[Upload] Processing ${files.length} items...`, 'system');
                    let successCount = 0;

                    for (const file of files) {
                        try {
                            const buffer = await file.arrayBuffer();
                            
                            // Determine Path
                            let relPath = file.name;
                            
                            // If uploading a folder, use the relative path (e.g. "myFolder/sub/file.txt")
                            if (isFolder && file.webkitRelativePath) {
                                relPath = file.webkitRelativePath;
                            }
                            
                            // Combine with Current Working Directory
                            // If CWD is /projects and file is server.js -> /projects/server.js
                            // If CWD is / and file is folder/file.txt -> /folder/file.txt
                            const fullPath = this.cwd === '/' 
                                ? `/${relPath}` 
                                : `${this.cwd}/${relPath}`;

                            // fs.writeFile handles creating intermediate directories automatically
                            const res = await fs.writeFile(fullPath, buffer);
                            
                            if (res.success) {
                                successCount++;
                                // Optional: Don't spam log for massive folders
                                if (files.length < 20) this.print(`Saved: ${fullPath}`, 'success');
                            } else {
                                this.print(`Error saving ${file.name}: ${res.error}`, 'error');
                            }
                        } catch (e) {
                            this.print(`Failed to read ${file.name}: ${e.message}`, 'error');
                        }
                    }
                    this.print(`[Upload] Finished. ${successCount}/${files.length} saved.`, 'accent');
                    input.remove(); // Cleanup
                };

                document.body.appendChild(input);
                input.click();
            },
            
            // --- DIRECTORY COMMANDS ---
            'pwd': () => this.print(this.cwd),

            'ls': async (args) => {
                const target = args[0] ? this.resolvePath(args[0]) : this.cwd;
                const res = await fs.listFiles(target);
                if (res.success) {
                    if (res.data.length === 0) return this.print("(empty)", 'system');
                    res.data.forEach(item => {
                        if(item.type === 'directory') this.print(`DIR  ${item.name}/`, 'accent');
                        else this.print(`FILE ${item.name}`);
                    });
                } else {
                    this.print(`Error: ${res.error}`, 'error');
                }
            },

            'cd': async (args) => {
                if (!args[0]) { this.cwd = '/'; this.updatePrompt(); return; }
                const target = this.resolvePath(args[0]);
                const res = await fs.listFiles(target);
                if (res.success) {
                    this.cwd = target;
                    this.updatePrompt();
                } else {
                    this.print(`cd: ${args[0]}: No such directory`, 'error');
                }
            },

            'mkdir': async (args) => {
                if (!args[0]) return this.print("Usage: mkdir <name>", 'error');
                const path = this.resolvePath(args[0]);
                const res = await fs.createDir(path);
                if(res.success) this.print(`Created ${path}`, 'success');
                else this.print(res.error, 'error');
            },

            'rm': async (args) => {
                if (!args[0]) return this.print("Usage: rm <path>", 'error');
                const path = this.resolvePath(args[0]);
                if (path === '/') return this.print("Cannot remove root", 'error');
                const res = await fs.remove(path);
                if(res.success) this.print(`Removed ${path}`, 'success');
                else this.print(res.error, 'error');
            },

            'cp': async (args) => {
                if (!args || args.length < 2) {
                    return this.print("Usage: cp [-r] [-f] <src> <dest>", 'error');
                }

                const flags = new Set();
                const operands = [];
                for (const arg of args) {
                    if (arg.startsWith('-') && arg.length > 1) {
                        for (const ch of arg.slice(1)) flags.add(ch);
                    } else {
                        operands.push(arg);
                    }
                }

                if (operands.length !== 2) {
                    return this.print("Usage: cp [-r] [-f] <src> <dest>", 'error');
                }

                const recursive = flags.has('r');
                const force = flags.has('f');

                const srcPath = this.resolvePath(operands[0]);
                const destPathInput = this.resolvePath(operands[1]);

                const srcStat = await statPath(srcPath);
                if (!srcStat.exists) {
                    return this.print(`cp: ${operands[0]}: No such file or directory`, 'error');
                }

                const destStat = await statPath(destPathInput);
                const srcBase = srcPath.split('/').filter(Boolean).pop() || '';
                const destPath = destStat.exists && destStat.isDir
                    ? normalizePath(`${destPathInput}/${srcBase}`)
                    : destPathInput;

                const targetStat = await statPath(destPath);
                if (targetStat.exists && !force) {
                    return this.print(`cp: ${destPath}: File exists (use -f to overwrite)`, 'error');
                }

                if (srcStat.isDir) {
                    if (!recursive) {
                        return this.print(`cp: ${operands[0]}: is a directory (use -r)`, 'error');
                    }

                    if (targetStat.exists && force) {
                        await fs.remove(destPath);
                    }
                    await fs.createDir(destPath);
                    await copyDirRecursive(srcPath, destPath, {});
                    this.print(`Copied ${srcPath} -> ${destPath}`, 'success');
                    return;
                }

                // file copy
                if (targetStat.exists && targetStat.isDir) {
                    return this.print(`cp: ${destPath}: is a directory`, 'error');
                }

                const readRes = await fs.readFile(srcPath, false);
                if (!readRes.success) {
                    return this.print(`cp: ${operands[0]}: Read failed`, 'error');
                }
                await fs.writeFile(destPath, readRes.data);
                this.print(`Copied ${srcPath} -> ${destPath}`, 'success');
            },

            // --- FILE UTILS ---
            'cat': async (args) => {
                if(!args[0]) return this.print("Usage: cat <filename>", 'error');
                const path = this.resolvePath(args[0]);
                const res = await fs.readFile(path, true);
                if(res.success) this.print(res.data);
                else this.print("File not found.", 'error');
            },

            'edit': (args) => {
                const editor = new Nano(this.os);
                if(args[0]) {
                    const path = this.resolvePath(args[0]);
                    this.openFileInIDE(path, editor);
                }
                else editor.open();
            },
            'md': (args) => {
                if(!args[0]) return this.print("Usage: md <file>", 'error');
                const editor = new Nano(this.os);
                const path = this.resolvePath(args[0]);
                this.openFileInIDE(path, editor, { preview: true });
            },

            // --- PROCESSES ---
            'run': async (args) => {
                if(!args[0]) return this.print("Usage: run <file>", 'error');
                const path = this.resolvePath(args[0]);
                const res = await fs.readFile(path, true);
                if(res.success) {
                    const pid = await this.os.spawn(res.data, path);
                    this.print(`[Process ${pid}] Started: ${path}`, 'system');
                }
                else this.print("File not found.", 'error');
            },
            
            
            'cmd': async (args) => {
  if (!args[0]) return this.print("Usage: cmd <file>", "error");
  const path = this.resolvePath(args[0]);
  const res = await fs.readFile(path, true);
  if (!res.success) return this.print(`File not found: ${path}`, "error");

  const lines = String(res.data)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"));

  for (const line of lines) {
    this.print(`user@mhnos:${this.cwd}$ ${line}`, "system");
    await this.execute(line);
  }
},

            
            // --- PYTHON PROCESSES ---
'python': async (args) => {
    if (!args[0]) {
        return this.print("Usage: python <file.py> | python -c <code>", 'error');
    }

    // python -c "print(123)"
    if (args[0] === "-c") {
        const code = args.slice(1).join(" ");
        if (!code.trim()) {
            return this.print("Usage: python -c <code>", 'error');
        }
        const pid = await this.os.spawnPython(code, "/inline.py");
        this.print(`[Process ${pid}] Started: /inline.py`, 'system');
        return;
    }

    // python file.py
    const path = this.resolvePath(args[0]);
    const res = await fs.readFile(path, true);

    if (res.success) {
        const pid = await this.os.spawnPython(res.data, path);
        this.print(`[Process ${pid}] Started: ${path}`, 'system');
    } else {
        this.print("File not found.", 'error');
    }
},

		
            // --- launching oapps ---
            'oapp': async (args) => {
                const sub = (args && args[0]) ? args[0] : '';
                if (sub === 'init') {
                    const target = (args && args[1]) ? args[1] : this.cwd;
                    const base = this.resolvePath(target).replace(/\/+$/, '');
                    const name = base.split('/').filter(Boolean).pop() || 'app';
                    await fs.createDir(base);
                    await fs.createDir(`${base}/src`);

                    const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/${base.replace(/^\/+/, '')}/src/main.tsx"></script>
  </body>
</html>
`;
                    const mainTsx = `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const root = createRoot(document.getElementById("root"));
root.render(<App />);
`;
                    const appTsx = `export default function App() {
  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>${name}</h1>
      <p>Edit src/App.tsx to get started.</p>
    </div>
  );
}
`;
const stylesCss = `body {
  background-color: #2c2c2c;
  color: #f2f2f2
}
`;
                    await fs.writeFile(`${base}/index.html`, indexHtml);
                    await fs.writeFile(`${base}/src/main.tsx`, mainTsx);
                    await fs.writeFile(`${base}/src/App.tsx`, appTsx);
                    await fs.writeFile(`${base}/src/styles.css`, stylesCss);

                    this.print(`[oapp] Vite-style app scaffolded at ${base}`, 'success');
                    this.print(`[oapp] Run: oapp ${base}`, 'accent');
                    return;
                }
                if (sub === 'build') {
                    const target = (args && args[1]) ? args[1] : this.cwd;
                    const base = this.resolvePath(target).replace(/\/+$/, '');
                    const appRoot = base;
                    const distDir = `${base}/dist`;
                    const assetsDir = `${distDir}/assets`;

                    const htmlRes = await fs.readFile(`${base}/index.html`, true);
                    if (!htmlRes.success) {
                        this.print(`Missing: ${base}/index.html`, 'error');
                        return;
                    }

                    const html = htmlRes.data || '';
                    const rawEntrySpec = findModuleEntry(html);
                    const entrySpec = rawEntrySpec ? rawEntrySpec.split('#')[0].split('?')[0] : '';
                    const entryPath = entrySpec
                        ? (entrySpec.startsWith('/') ? normalizePath(entrySpec) : normalizePath(`${base}/${entrySpec}`))
                        : normalizePath(`${base}/src/main.tsx`);

                    const entryResolved = await resolveWithExtensions(entryPath) || entryPath;
                    const entryStat = await statPath(entryResolved);
                    if (!entryStat.exists || entryStat.isDir) {
                        this.print(`[oapp] Entry not found: ${entryResolved}`, 'error');
                        return;
                    }

                    try { await fs.remove(distDir); } catch {}
                    await fs.createDir(distDir);
                    await fs.createDir(assetsDir);
                    await copyDirRecursive(base, distDir, {
                        excludeDirs: new Set(['src', 'dist', 'node_modules']),
                        skipRootIndex: true
                    });

                    const esbuild = await ensureEsbuild();
                    const plugin = {
                        name: 'opfs-resolver',
                        setup(build) {
                            build.onResolve({ filter: /.*/ }, async (args) => {
                                if (args.path.startsWith('http://') || args.path.startsWith('https://')) {
                                    return { path: args.path, external: true };
                                }
                                if (args.path.startsWith('.') || args.path.startsWith('/')) {
                                    const resolved = args.path.startsWith('.')
                                        ? normalizePath(`${args.resolveDir || '/'}${args.path.startsWith('.') ? '/' : ''}${args.path}`)
                                        : normalizePath(args.path);
                                    const withExt = await resolveWithExtensions(resolved);
                                    return { path: withExt || resolved, namespace: 'opfs' };
                                }
                                const resolvedBare = await resolveBarePath(args.path, appRoot);
                                return { path: resolvedBare, namespace: 'opfs' };
                            });
                            build.onLoad({ filter: /.*/, namespace: 'opfs' }, async (args) => {
                                const loader = guessLoader(args.path);
                                if (loader === 'file') {
                                    const res = await fs.readFile(args.path, false);
                                    if (!res || !res.success) throw new Error(`File not found: ${args.path}`);
                                    return { contents: new Uint8Array(res.data || []), loader, resolveDir: dirname(args.path) };
                                }
                                const res = await fs.readFile(args.path, true);
                                if (!res || !res.success) throw new Error(`File not found: ${args.path}`);
                                return { contents: res.data || '', loader, resolveDir: dirname(args.path) };
                            });
                        }
                    };

                    let result;
                    try {
                        result = await esbuild.build({
                            entryPoints: [entryResolved],
                            bundle: true,
                            format: 'esm',
                            platform: 'browser',
                            write: false,
                            sourcemap: false,
                            outdir: '.',
                            entryNames: 'assets/app',
                            assetNames: 'assets/[name]-[hash]',
                            plugins: [plugin]
                        });
                    } catch (e) {
                        this.print(`[oapp] Build failed: ${e.message}`, 'error');
                        return;
                    }

                    const outputFiles = result && result.outputFiles ? result.outputFiles : [];
                    let wroteCss = false;
                    for (const file of outputFiles) {
                        const outPath = String(file.path || '');
                        let rel = outPath.startsWith('dist/') ? outPath.slice(5) : outPath;
                        if (rel.startsWith('./')) rel = rel.slice(2);
                        if (rel.startsWith('dist/')) rel = rel.slice(5);
                        if (rel.startsWith('/')) rel = rel.slice(1);
                        if (!rel) continue;
                        const dest = `${distDir}/${rel}`;
                        await fs.createDir(dirname(dest));
                        const contents = file.contents ? file.contents : new TextEncoder().encode(file.text || '');
                        await fs.writeFile(dest, contents);
                        if (rel.endsWith('.css')) wroteCss = true;
                    }

                    if (!wroteCss) {
                        await fs.writeFile(`${assetsDir}/app.css`, '');
                    }

                    const outHtml = rewriteIndexHtml(html, './assets/app.js', './assets/app.css');
                    await fs.writeFile(`${distDir}/index.html`, outHtml);

                    this.print(`[oapp] Built to ${distDir}`, 'success');
                    return;
                }

                const folder = sub;
                if (!folder) {
                    this.print('Usage: oapp <path> | oapp init [path] | oapp build [path]', 'error');
                    return;
                }

                const base = this.resolvePath(folder).replace(/\/+$/, '');

                const htmlRes = await fs.readFile(`${base}/index.html`, true);
                if (!htmlRes.success) {
                    this.print(`Missing: ${base}/index.html`, 'error');
                    return;
                }

                if (navigator.serviceWorker && navigator.serviceWorker.ready) {
                    try { await navigator.serviceWorker.ready; } catch {}
                }
                if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
                    this.print('[oapp] Service worker not controlling this page. Reload the OS once and try again.', 'error');
                    return;
                }

                const viewport = document.createElement('div');
                viewport.style.cssText = 'width:100%; height:100%; background:#111;';

                const iframe = document.createElement('iframe');
                iframe.style.cssText = 'width:100%; height:100%; border:none; background:#fff;';
                iframe.src = `${base}/index.html`;

                viewport.appendChild(iframe);

                this.os.wm.createWindow(`oapp: ${base}`, viewport, { width: 900, height: 650 });
                this.print(`[oapp] Launched ${base}`, 'success');
            },


            // --- NPM COMMAND (Delegates to PackageManager) ---
            'npm': async (args) => {
                const [action, ...rest] = args;
                if (action === 'install') {
                    const isGlobal = rest.includes('-g') || rest.includes('--global');
                    const pkgArg = rest.find(arg => !arg.startsWith('-'));
                    if (!pkgArg || pkgArg === 'package.json') {
                        const path = this.resolvePath(pkgArg || 'package.json');
                        await this.npm.installFromPackageJson(path);
                    } else {
                        await this.npm.install(pkgArg, { global: isGlobal });
                    }
                    return;
                }
                this.print("Usage: npm install <package|package.json> [-g|--global]", 'error');
            },

            'serverhere': async () => {
                const sourcePath = '/demos/site/server.js';
                const destPath = this.resolvePath('server.js');

                const res = await fs.readFile(sourcePath, true);
                if (!res.success) {
                    this.print(`[serverhere] Missing source: ${sourcePath}`, 'error');
                    return;
                }

                const writeRes = await fs.writeFile(destPath, res.data || '');
                if (writeRes && writeRes.success) {
                    this.print(`[serverhere] Wrote ${destPath}`, 'success');
                } else {
                    this.print(`[serverhere] Failed to write ${destPath}`, 'error');
                    return;
                }

                await this.npm.install('express');
            },
            
            'wget': async (args) => {
    const url = args[0];
    if (!url) return this.print("Usage: wget <url> [filename]", 'error');

    // Determine filename (use 2nd arg, or derive from URL, or default)
    let filename = args[1];
    if (!filename) {
        const parts = url.split('/');
        filename = parts[parts.length - 1] || 'downloaded_file';
    }

    // Resolve path relative to CWD
    const fullPath = this.resolvePath(filename);

    this.print(`Downloading ${url}...`, 'system');
    
    try {
        const res = await this.os.fetch(url, { responseType: 'arraybuffer' });
        if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
        
        const buffer = res.body instanceof ArrayBuffer
            ? res.body
            : new TextEncoder().encode(String(res.body || '')).buffer;
        const result = await fs.writeFile(fullPath, buffer);
        
        if (result.success) {
            this.print(`Saved to ${fullPath} (${buffer.byteLength} bytes)`, 'success');
        } else {
            throw new Error(result.error);
        }
    } catch (e) {
        this.print(`Download failed: ${e.message}`, 'error');
        this.print(`Note: Cross-Origin (CORS) blocked requests will fail.`, 'system');
    }
},
            'gitclone': async (args) => {
                const url = args[0];
                const dest = args[1];
                if (!url) return this.print("Usage: gitclone <git-url> [dest]", 'error');
                await this.downloadGitHubRepo(url, dest);
            },

            'backup': (args) => runBackupCommand(this, args),

            // --- APPS ---
            'files': () => new FileExplorer(this.os).open(this.cwd),
            'site': async (args) => {
  const folder = (args && args[0]) ? args[0] : '';
  if (!folder) {
    this.print('Usage: site /apps/<name>', 'error');
    return;
  }

  const base = folder.endsWith('/') ? folder.slice(0, -1) : folder;

  const htmlRes = await fs.readFile(`${base}/index.html`, true);
  const cssRes  = await fs.readFile(`${base}/styles.css`, true);
  const jsRes   = await fs.readFile(`${base}/app.js`, true);

  if (!htmlRes.success) { this.print(`Missing: ${base}/index.html`, 'error'); return; }
  if (!cssRes.success)  { this.print(`Missing: ${base}/styles.css`, 'error'); return; }
  if (!jsRes.success)   { this.print(`Missing: ${base}/app.js`, 'error'); return; }

  const html = htmlRes.data || '';
  const css  = cssRes.data || '';
  const js   = jsRes.data || '';

  // Build srcdoc: inline css + js so it runs with no server
  const srcdoc = buildSrcdoc(html, css, js);

  const viewport = document.createElement('div');
  viewport.style.cssText = 'width:100%; height:100%; background:#111;';

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'width:100%; height:100%; border:none; background:#fff;';
  iframe.srcdoc = srcdoc;

  viewport.appendChild(iframe);

  this.os.wm.createWindow(`Site: ${base}`, viewport, { width: 900, height: 650 });
  this.print(`[site] Launched ${base}`, 'success');

  function buildSrcdoc(indexHtml, cssText, jsText) {
    let out = indexHtml;

    // swap external file refs if present
    out = out.replace(
      /<link[^>]*rel=["']stylesheet["'][^>]*href=["']styles\.css["'][^>]*>/i,
      `<style>\n${cssText}\n</style>`
    );
    out = out.replace(
      /<script[^>]*src=["']app\.js["'][^>]*>\s*<\/script>/i,
      `<script>\n${jsText}\n<\/script>`
    );

    // if they forgot those tags, inject
    if (!/<style[\s>]/i.test(out)) {
      out = out.replace(/<\/head>/i, `<style>\n${cssText}\n</style>\n</head>`);
    }
    if (!/<script[\s>]/i.test(out)) {
      out = out.replace(/<\/body>/i, `<script>\n${jsText}\n<\/script>\n</body>`);
    }

    return out;
  }
},

            'browser': () => new BrowserApp(this.os).open(),
			'companion': () => new CompanionApp(this.os).open(),
            'appbuilder': () => new CompanionApp(this.os).open(),
            'packedit': (args) => new PackeditEditor(this.os).open(args && args[0] ? args[0] : '/apps'),
            'launcher': () => {
                if (this.os.launcher) this.os.launcher.open();
                else new LauncherApp(this.os).open();
            },
            
            // --- SYSTEM ---
            'ps': () => {
                this.print("PID  |  NAME           |  PORTS", 'system');
                this.print("-----|-----------------|-------", 'system');
                if (this.os.procs.size === 0) this.print("No active processes.", 'system');
                else {
                    this.os.procs.forEach((proc, pid) => {
                        const ports = Array.from(proc.ports).join(', ') || '-';
                        this.print(`${pid.toString().padEnd(4)} | ${proc.name.padEnd(15)} | ${ports}`);
                    });
                }
            },
            
            'kill': (args) => {
                const pid = parseInt(args[0]);
                if (!pid) return this.print("Usage: kill <pid>", 'error');
                if (this.os.procs.has(pid)) this.os.kill(pid);
                else this.print(`PID ${pid} not found.`, 'error');
            },

            'tty': (args) => {
                const sub = (args[0] || 'status').toLowerCase();
                if (sub === 'status') {
                    if (this.os.ttyAttachedPid) {
                        this.print(`[TTY] Attached to PID ${this.os.ttyAttachedPid}`, 'system');
                    } else {
                        this.print('[TTY] Not attached', 'system');
                    }
                    return;
                }
                if (sub === 'attach') {
                    const pid = parseInt(args[1]);
                    if (!pid) return this.print("Usage: tty attach <pid>", 'error');
                    if (!this.os.procs.has(pid)) return this.print(`PID ${pid} not found.`, 'error');
                    this.os.attachTty(pid, (payload) => {
                        this.print(`[${pid}] ${payload.data}`, payload.stream === 'stderr' ? 'error' : '');
                    });
                    this.print(`[TTY] Attached to PID ${pid}. Ctrl+C to detach.`, 'success');
                    return;
                }
                if (sub === 'detach') {
                    this.os.detachTty();
                    this.print('[TTY] Detached', 'system');
                    return;
                }
                this.print("Usage: tty [attach|detach|status]", 'error');
            },

            'term': (args) => {
                const pid = parseInt(args[0]);
                if (!pid) return this.print("Usage: term <pid>", 'error');
                if (!this.os.procs.has(pid)) return this.print(`PID ${pid} not found.`, 'error');
                new TerminalApp(this.os).open(pid);
            },

            'net': (args) => {
                const sub = (args[0] || 'status').toLowerCase();
                if (sub === 'status') {
                    const status = this.os.getNetStatus();
                    const stateMap = { 0: 'connecting', 1: 'open', 2: 'closing', 3: 'closed' };
                    const proxyState = status.proxyState === null ? 'none' : (stateMap[status.proxyState] || 'unknown');
                    this.print(`[NET] Mode: ${status.mode}`, 'system');
                    this.print(`[NET] Proxy: ${status.proxyUrl || '(unset)'} (${proxyState})`, 'system');
                    if (status.lastError) this.print(`[NET] Last error: ${status.lastError}`, 'error');
                    return;
                }
                if (sub === 'mode') {
                    const mode = (args[1] || '').toLowerCase();
                    if (!['direct', 'proxy', 'worker'].includes(mode)) {
                        this.print("Usage: net mode <direct|proxy|worker>", 'error');
                        return;
                    }
                    this.os.setNetMode(mode);
                    this.print(`[NET] Mode set to ${mode}`, 'success');
                    return;
                }
                if (sub === 'proxy') {
                    const url = args[1];
                    if (!url) return this.print("Usage: net proxy <ws-url>", 'error');
                    this.os.setProxyUrl(url);
                    this.print(`[NET] Proxy URL set to ${url}`, 'success');
                    return;
                }
                this.print("Usage: net [status|mode|proxy]", 'error');
            }
        };

        this.attachListeners();
        this.attachDragAndDrop();
        this.updatePrompt();
    }

    resolvePath(inputPath) {
        if (!inputPath) return this.cwd;
        
        if (inputPath.startsWith('/')) return inputPath;

        const parts = this.cwd.split('/').filter(p => p);
        const inputParts = inputPath.split('/');

        for (const part of inputParts) {
            if (part === '.') continue;
            if (part === '..') parts.pop();
            else parts.push(part);
        }

        const res = '/' + parts.join('/');
        return res === '//' ? '/' : res;
    }

    updatePrompt() {
        if(this.promptStr) this.promptStr.textContent = `user@mhnos:${this.cwd}$`;
    }

attachListeners() {
  this.input.addEventListener('keydown', async (e) => {

    // TAB AUTOCOMPLETE (HUD shell only)
    if (e.key === 'Tab') {
      e.preventDefault();

      // Only autocomplete when NOT attached to TTY
      if (this.os.ttyAttachedPid) return;

      const raw = this.input.value;
      const cursor = this.input.selectionStart ?? raw.length;
      const before = raw.slice(0, cursor);

      const parts = before.split(/\s+/);
      const frag = parts[parts.length - 1] || '';

// command completion for first token, path completion for later tokens

if (parts.length === 1) {
  // COMMAND completion
  const matches = Object.keys(this.commands)
    .filter(c => c.startsWith(frag))
    .sort();

  if (matches.length === 1) {
    this.input.value = matches[0] + ' ';
  } else if (matches.length > 1) {
    this.print(matches.join('    '), 'system');
  }
  return;
}

// PATH completion (2nd token and beyond)
const token = frag;

// Split token into "dirPart" + "baseFrag"
const lastSlash = token.lastIndexOf('/');
const dirPart = lastSlash >= 0 ? token.slice(0, lastSlash + 1) : '';
const baseFrag = lastSlash >= 0 ? token.slice(lastSlash + 1) : token;

// Determine which directory to list
// - if user typed "some/dir/pa" => list "some/dir/"
// - if user typed "pa" => list current cwd
const dirToList = dirPart ? this.resolvePath(dirPart) : this.cwd;

// List directory and match entries
const res = await fs.listFiles(dirToList);
if (!res.success) return;

const matches = res.data
  .map(ent => ent.name + (ent.type === 'directory' ? '/' : ''))
  .filter(name => name.startsWith(baseFrag))
  .sort();

if (matches.length === 1) {
  // Replace just the fragment token (not the whole input)
  const completed = dirPart + matches[0];

  parts[parts.length - 1] = completed;
  const newBefore = parts.join(' ') + (completed.endsWith('/') ? '' : ''); // don't force space
  this.input.value = newBefore + raw.slice(cursor);
  const newCursor = newBefore.length;
  this.input.setSelectionRange(newCursor, newCursor);
} else if (matches.length > 1) {
  this.print(matches.join('    '), 'system');
}

      return;
    }

    // CTRL+C
    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();

      if (this.os.ttyAttachedPid) {
        const pid = this.os.ttyAttachedPid;
        this.os.sendTtyInput(pid, '\u0003');
        this.os.detachTty();
        this.print(`[TTY] Detached from PID ${pid}`, 'system');
        this.input.value = '';
        return;
      }

      if (this.os.procs.size > 0) {
        const lastPid = [...this.os.procs.keys()].pop();
        this.os.kill(lastPid);
      }

      this.input.value = '';
      return;
    }

    // ENTER
    if (e.key === 'Enter') {
      const val = this.input.value.trim();

      if (this.os.ttyAttachedPid) {
        const pid = this.os.ttyAttachedPid;
        this.os.sendTtyInput(pid, val + '\n');
        this.input.value = '';
        return;
      }

      if (val) {
        this.history.push(val);
        this.historyIndex = this.history.length;
        this.print(`user@mhnos:${this.cwd}$ ${val}`, 'system');
        await this.execute(val);
        this.input.value = '';
      }

      return;
    }

    // HISTORY UP
    if (e.key === 'ArrowUp') {
      if (this.historyIndex > 0) {
        this.historyIndex--;
        this.input.value = this.history[this.historyIndex];
      }
      return;
    }

  });

        
        document.addEventListener('click', (e) => {
            const tag = e.target.tagName;
            if (tag !== 'TEXTAREA' && tag !== 'INPUT' && tag !== 'BUTTON') {
                this.input.focus();
            }
        });
        
        setTimeout(() => this.input.focus(), 100);
    }
    
    async execute(raw) {
        const [cmd, ...args] = raw.split(' ');
        if (this.commands[cmd]) {
            try {
                await this.commands[cmd](args);
            } catch (err) {
                this.print(`Error: ${err.message}`, 'error');
            }
        } else {
            this.print(`Command not found: ${cmd}`, 'error');
        }
    }

    print(msg, type = '') {
        const line = document.createElement('div');
        line.className = `log-line ${type}`;
        line.textContent = msg;
        this.output.appendChild(line);
        this.output.scrollTop = this.output.scrollHeight;
    }

    async openFileInIDE(path, ideInstance, options = {}) {
        const res = await fs.readFile(path, true);
        if(res.success) ideInstance.open(path, res.data, options);
        else ideInstance.open(path, '', options);
    }

    parseGitHubRepoUrl(rawUrl) {
        const input = rawUrl.trim();
        const sshMatch = input.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
        if (sshMatch) {
            return { owner: sshMatch[1], repo: sshMatch[2], ref: null };
        }

        try {
            const parsed = new URL(input);
            if (parsed.hostname !== 'github.com') return null;
            const parts = parsed.pathname.split('/').filter(Boolean);
            if (parts.length < 2) return null;
            const owner = parts[0];
            const repo = parts[1].replace(/\.git$/, '');
            let ref = null;
            if (parts[2] === 'tree' && parts[3]) ref = parts[3];
            return { owner, repo, ref };
        } catch (e) {
            return null;
        }
    }

    async downloadGitHubRepo(rawUrl, destArg) {
        const info = this.parseGitHubRepoUrl(rawUrl);
        if (!info) {
            this.print("gitclone: Only GitHub URLs are supported.", 'error');
            return;
        }

        const { owner, repo } = info;
        let branch = info.ref;
        const targetDir = this.resolvePath(destArg || repo);

        this.print(`[gitclone] Fetching ${owner}/${repo}...`, 'system');

        if (!branch) {
            const repoRes = await this.os.fetch(`https://api.github.com/repos/${owner}/${repo}`, { responseType: 'text' });
            if (repoRes.statusCode !== 200) {
                this.print(`[gitclone] Repo not found (HTTP ${repoRes.statusCode}).`, 'error');
                return;
            }
            const repoData = JSON.parse(repoRes.body || '{}');
            branch = repoData.default_branch || 'main';
        }

        const treeRes = await this.os.fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { responseType: 'text' });
        if (treeRes.statusCode !== 200) {
            this.print(`[gitclone] Unable to fetch repo tree (HTTP ${treeRes.statusCode}).`, 'error');
            return;
        }
        const treeData = JSON.parse(treeRes.body || '{}');
        if (!Array.isArray(treeData.tree)) {
            this.print(`[gitclone] Invalid tree data.`, 'error');
            return;
        }

        if (treeData.truncated) {
            this.print(`[gitclone] Warning: tree truncated by GitHub API.`, 'error');
        }

        await fs.createDir(targetDir);

        const blobs = treeData.tree.filter(entry => entry.type === 'blob');
        this.print(`[gitclone] Downloading ${blobs.length} file(s) from ${branch}...`, 'system');

        let saved = 0;
        let failed = 0;
        const encodedBranch = branch.split('/').map(encodeURIComponent).join('/');

        for (const entry of treeData.tree) {
            if (entry.type === 'tree') {
                await fs.createDir(`${targetDir}/${entry.path}`);
                continue;
            }
            if (entry.type !== 'blob') continue;

            const encodedPath = entry.path.split('/').map(encodeURIComponent).join('/');
            const fileUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodedBranch}/${encodedPath}`;
            try {
                const fileRes = await this.os.fetch(fileUrl, { responseType: 'arraybuffer' });
                if (fileRes.statusCode !== 200) {
                    failed += 1;
                    continue;
                }
                const buffer = fileRes.body instanceof ArrayBuffer
                    ? fileRes.body
                    : new TextEncoder().encode(String(fileRes.body || '')).buffer;
                const writeRes = await fs.writeFile(`${targetDir}/${entry.path}`, buffer);
                if (writeRes.success) saved += 1;
                else failed += 1;
            } catch (e) {
                failed += 1;
            }
        }

        const resultMsg = `[gitclone] Saved ${saved} file(s) to ${targetDir}` +
            (failed ? `, ${failed} failed.` : '.');
        this.print(resultMsg, failed ? 'error' : 'success');
    }
    
    attachDragAndDrop() {
    const dropZone = document.body;

    // Prevent default browser behavior (opening the file)
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, false);
    });

    // Visual feedback (optional)
    dropZone.addEventListener('dragover', () => dropZone.style.boxShadow = 'inset 0 0 20px #0078d7');
    dropZone.addEventListener('dragleave', () => dropZone.style.boxShadow = 'none');
    dropZone.addEventListener('drop', () => dropZone.style.boxShadow = 'none');

    const writeDroppedFile = async (file, basePath) => {
        const buffer = await file.arrayBuffer();
        const savePath = `${basePath}/${file.name}`;
        const res = await fs.writeFile(savePath, buffer);
        if (res.success) {
            this.print(`[Upload] Saved: ${savePath}`, 'success');
        } else {
            this.print(`[Upload] Error saving ${file.name}: ${res.error}`, 'error');
        }
    };

    const walkDirectoryHandle = async (dirHandle, basePath) => {
        const dirPath = `${basePath}/${dirHandle.name}`;
        await fs.createDir(dirPath);
        for await (const entry of dirHandle.values()) {
            if (entry.kind === 'file') {
                const file = await entry.getFile();
                await writeDroppedFile(file, dirPath);
            } else if (entry.kind === 'directory') {
                await walkDirectoryHandle(entry, dirPath);
            }
        }
    };

    const walkWebkitEntry = async (entry, basePath) => {
        if (entry.isFile) {
            await new Promise((resolve) => {
                entry.file(async (file) => {
                    await writeDroppedFile(file, basePath);
                    resolve();
                });
            });
            return;
        }
        if (entry.isDirectory) {
            const dirPath = `${basePath}/${entry.name}`;
            await fs.createDir(dirPath);
            const reader = entry.createReader();
            const readEntries = async () => {
                const entries = await new Promise((resolve) => reader.readEntries(resolve));
                if (!entries.length) return;
                for (const child of entries) {
                    await walkWebkitEntry(child, dirPath);
                }
                await readEntries();
            };
            await readEntries();
        }
    };

    // Handle Drop
    dropZone.addEventListener('drop', async (e) => {
        const items = Array.from(e.dataTransfer.items || []);
        const basePath = this.cwd === '/' ? '' : this.cwd;

        if (items.length > 0 && items.some(item => item.kind === 'file')) {
            this.print(`[Upload] Processing ${items.length} item(s)...`, 'system');
            for (const item of items) {
                if (item.kind !== 'file') continue;
                if (item.getAsFileSystemHandle) {
                    const handle = await item.getAsFileSystemHandle();
                    if (!handle) continue;
                    if (handle.kind === 'file') {
                        const file = await handle.getFile();
                        await writeDroppedFile(file, basePath);
                    } else if (handle.kind === 'directory') {
                        await walkDirectoryHandle(handle, basePath);
                    }
                } else if (item.webkitGetAsEntry) {
                    const entry = item.webkitGetAsEntry();
                    if (entry) await walkWebkitEntry(entry, basePath);
                } else {
                    const file = item.getAsFile();
                    if (file) await writeDroppedFile(file, basePath);
                }
            }
            return;
        }

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            this.print(`[Upload] Processing ${files.length} file(s)...`, 'system');
            for (const file of files) {
                await writeDroppedFile(file, basePath);
            }
        }
    });
}
}
