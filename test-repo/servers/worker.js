const http = require('http');
const { runAction } = require('./worker-core');

const PORT = 4000;

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}

function parseQuery(url) {
  const parsed = new URL(`http://localhost${url}`);
  return {
    pathname: parsed.pathname,
    params: Object.fromEntries(parsed.searchParams.entries())
  };
}

http.createServer(async (req, res) => {
  const { pathname, params } = parseQuery(req.url || '/');

  if (pathname === '/health') {
    return sendJson(res, 200, { ok: true, service: 'worker', port: PORT });
  }

  if (pathname === '/action') {
    const action = params.action || 'parse';
    try {
      const result = await runAction(action, params);
      return sendJson(res, result.ok ? 200 : 400, { action, result });
    } catch (err) {
      return sendJson(res, 500, { action, ok: false, error: err.message });
    }
  }

  sendJson(res, 404, { ok: false, error: 'Not Found' });
}).listen(PORT, () => {
  console.log(`[Worker] Listening on :${PORT}`);
});
