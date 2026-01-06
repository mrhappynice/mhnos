// src/system/npm.js
import * as fs from '../kernel/fs.js';

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
    'react': async () => {
        const res = await fetch('https://unpkg.com/react@18.2.0/umd/react.development.js');
        const code = await res.text();
        return `
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
`;
    },

    // --- RECIPE: REACT-DOM (Robust UMD Wrapper) ---
    'react-dom': async () => {
        const res = await fetch('https://unpkg.com/react-dom@18.2.0/umd/react-dom-server.browser.development.js');
        const code = await res.text();
        return `
// 1. Ensure React is available globally (UMD fallback)
if (!self.React) {
    try { self.React = require('react'); } catch(e) {}
}

// 2. Run UMD Code
${code}

// 3. WebOS Shim: Force export of ReactDOMServer
if (self.ReactDOMServer) {
    module.exports = self.ReactDOMServer;
}
`;
    }
};

export class PackageManager {
    constructor(shell) {
        this.shell = shell;
    }

    async install(pkgName) {
        const cwd = this.shell.cwd;
        const installDir = cwd === '/' ? '/node_modules' : `${cwd}/node_modules`;
        await fs.createDir(installDir);

        this.shell.print(`[NPM] Resolving ${pkgName}...`, 'system');

        let code = null;
        try {
            if (RECIPES[pkgName]) {
                this.shell.print(`[NPM] Using custom recipe for ${pkgName}...`, 'system');
                code = await RECIPES[pkgName]();
            } else {
                this.shell.print(`[NPM] Fetching from unpkg...`, 'system');
                let url = `https://unpkg.com/${pkgName}`;
                if(pkgName === 'lodash') url = `https://unpkg.com/lodash@4.17.21/lodash.js`;
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                code = await res.text();
                if (code.trim().startsWith('<')) throw new Error("Not a JS file");
            }

            await fs.writeFile(`${installDir}/${pkgName}.js`, code);
            this.shell.print(`[NPM] ${pkgName} installed successfully.`, 'success');

        } catch (e) {
            this.shell.print(`[NPM] Install Failed: ${e.message}`, 'error');
        }
    }
}