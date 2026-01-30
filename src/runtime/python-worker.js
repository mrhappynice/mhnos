// src/runtime/python-worker.js

let pyodide = null;
let nativeFS = null;

// Line-buffer for stdin
let stdinLineQueue = [];
let stdinPartial = "";

function ttyWrite(data, stream = "stdout") {
  postMessage({
    type: "SYSCALL_TTY_WRITE",
    payload: { data: String(data ?? ""), stream }
  });
}

function pushStdinText(text) {
  stdinPartial += text;

  // Split into lines (keep newline semantics)
  let idx;
  while ((idx = stdinPartial.indexOf("\n")) !== -1) {
    const line = stdinPartial.slice(0, idx + 1); // include newline
    stdinPartial = stdinPartial.slice(idx + 1);
    stdinLineQueue.push(line);
  }
}

async function ensurePyodide() {
  if (pyodide) return pyodide;

  // You must actually vendor these files at /vendor/pyodide/full/
  importScripts("/vendor/pyodide/full/pyodide.js");

  pyodide = await loadPyodide({
    indexURL: "/vendor/pyodide/full/"
  });

  // stdout / stderr -> OS TTY
  pyodide.setStdout({ batched: (s) => ttyWrite(s, "stdout") });
  pyodide.setStderr({ batched: (s) => ttyWrite(s, "stderr") });

  // stdin for Python input()
  // NOTE: setStdin stdin callback is synchronous.
  pyodide.setStdin({
    isatty: true,
    stdin: () => {
      // If no line is available, behave like "no input"
      // You can also return "" to signal EOF.
      if (stdinLineQueue.length === 0) return "";
      return stdinLineQueue.shift();
    }
  });

  // Mount OPFS root at /opfs (no picker UX)
  if (navigator.storage?.getDirectory) {
    const root = await navigator.storage.getDirectory();
    nativeFS = await pyodide.mountNativeFS("/opfs", root);
    pyodide.runPython(`import os; os.chdir("/opfs")`);
  } else {
    ttyWrite("[python] OPFS not available; using in-memory FS\n", "stderr");
  }

  return pyodide;
}

async function runPython({ code, filename = "<stdin>" }) {
  const py = await ensurePyodide();

  // Try to auto-load built-in packages referenced by imports
  try {
    await py.loadPackagesFromImports(code);
  } catch {}

  py.globals.set("__mhnos_filename__", filename);

  const wrapped = `
import traceback

_code = ${JSON.stringify(code)}
_fname = __mhnos_filename__

try:
    try:
        _result = eval(compile(_code, _fname, "eval"))
        if _result is not None:
            print(_result)
    except SyntaxError:
        exec(compile(_code, _fname, "exec"), globals(), globals())
except Exception:
    traceback.print_exc()
`;

  py.runPython(wrapped);

  // Flush to OPFS (method call)
  if (nativeFS && typeof nativeFS.syncfs === "function") {
    try { await nativeFS.syncfs(); } catch {}
  }
}

self.onmessage = async (event) => {
  const { type, payload } = event.data || {};

  try {
    if (type === "TTY_INPUT") {
      const data = payload?.data ?? "";
      pushStdinText(data);
      return;
    }

if (type === "EXEC_PY") {
  await runPython({
    code: payload?.code ?? "",
    filename: payload?.path ?? "<stdin>"
  });
  return;
}

    // Optional fallback if you do NOT mount OPFS:
    // mirror the kernel's FS snapshot into Pyodide FS.
    if (type === "WRITE_VIRTUAL_FILE") {
      const py = await ensurePyodide();
      if (nativeFS) return;

      const { path, kind, content } = payload || {};
      if (!path) return;

      if (kind === "directory") {
        py.FS.mkdirTree(path);
      } else if (kind === "file") {
        py.FS.mkdirTree(path.split("/").slice(0, -1).join("/") || "/");
        py.FS.writeFile(path, new Uint8Array(content));
      }
      return;
    }
  } catch (err) {
    const msg = err?.stack || err?.message || String(err);
    ttyWrite(`[python error] ${msg}\n`, "stderr");
  }
};

