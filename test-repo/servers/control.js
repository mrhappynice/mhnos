const http = require('http');
const fs = require('fs');
const { runAction, DEFAULT_REMOTE_URL } = require('./worker-core');

const PORT = 3000;
const path = require('path');
const PUBLIC_DIR = path.join(process.cwd(), '../public');

function parseQuery(url) {
  const parsed = new URL(`http://localhost${url}`);
  return {
    pathname: parsed.pathname,
    params: Object.fromEntries(parsed.searchParams.entries())
  };
}

function getContentType(pathname) {
  if (pathname.endsWith('.css')) return 'text/css';
  if (pathname.endsWith('.js')) return 'application/javascript';
  if (pathname.endsWith('.html')) return 'text/html';
  return 'text/plain';
}

function safePath(pathname) {
  if (pathname.includes('..')) return null;
  return pathname;
}

function serveStatic(res, pathname) {
  const clean = safePath(pathname);
  if (!clean) return false;
  const full = `${PUBLIC_DIR}${clean}`;
  try {
    const body = fs.readFileSync(full, 'utf8');
    res.writeHead(200, { 'content-type': getContentType(clean) });
    res.end(body);
    return true;
  } catch (err) {
    return false;
  }
}

function renderResultBlock(action, result) {
  if (!action) {
    return '<div class="result-empty">Run an action to see results here.</div>';
  }
  const pretty = JSON.stringify(result, null, 2);
  return `
    <div class="result-card">
      <div class="result-title">Last Action: ${action}</div>
      <pre class="result-pre">${pretty}</pre>
    </div>
  `;
}

function renderPage(params, actionResult) {
  const action = params.action || '';
  const defaultUrl = DEFAULT_REMOTE_URL;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MHNOS Control Hub</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div class="app">
    <header class="hero">
      <div class="badge">MHNOS Demo</div>
      <h1>Control Hub</h1>
      <p>Two servers, one OS. Click an action to run it and watch the worker respond.</p>
      <div class="tip">
        The Control Hub can ask the OS browser to navigate for you. If your environment blocks it, copy the URL and press Go.
      </div>
    </header>

    <section class="grid">
      <div class="panel">
        <h2>Quick Actions</h2>
        <div class="actions" data-default-url="${defaultUrl}">
          <button data-action="parse" data-format="csv">Parse CSV</button>
          <button data-action="parse" data-format="json">Parse JSON</button>
          <button data-action="parse" data-format="yaml">Parse YAML</button>
          <button data-action="generate">Generate Report</button>
          <button data-action="search" data-query="nova">Search Dataset</button>
          <button data-action="write">Generate File Draft</button>
          <button data-action="remote" data-url="${defaultUrl}">Fetch Remote</button>
        </div>
    <section class="results">
      <h2>Results</h2>
      ${renderResultBlock(action, actionResult)}
    </section>
        <div class="url-builder">
          <label>Action URL</label>
          <input id="action-url" readonly value="localhost:${PORT}/" />
          <button id="copy-url">Copy URL</button>
        </div>
        <div class="helper">
          Actions attempt to auto-run. If not, paste the URL into the OS browser bar and press Go.
        </div>
      </div>

      <div class="panel">
        <h2>Worker Endpoint</h2>
        <p>The worker server listens on port 4000. You can hit it directly from the URL bar:</p>
        <div class="endpoint">localhost:4000/action?action=parse&format=csv</div>
        <div class="endpoint">localhost:4000/action?action=remote&url=${defaultUrl}</div>
        <p class="note">Control Hub uses the worker logic internally to render results on this page.</p>
      </div>
    </section>


    <section class="instructions">
      <h2>What This Proves</h2>
      <ul>
        <li>Two independent servers are running (ports 3000 and 4000).</li>
        <li>Worker actions parse data, generate reports, fetch remote JSON, and run search.</li>
        <li>Remote fetch uses ${defaultUrl} and shows network reachability.</li>
      </ul>
    </section>
  </div>

  <script src="/app.js"></script>
</body>
</html>`;
}

http.createServer(async (req, res) => {
  const { pathname, params } = parseQuery(req.url || '/');

  if (pathname !== '/' && serveStatic(res, pathname)) {
    return;
  }

  let actionResult = null;
  if (params.action) {
    try {
      actionResult = await runAction(params.action, params);
    } catch (err) {
      actionResult = { ok: false, error: err.message };
    }
  }

  const body = renderPage(params, actionResult);
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(body);
}).listen(PORT, () => {
  console.log(`[Control] Listening on :${PORT}`);
});
