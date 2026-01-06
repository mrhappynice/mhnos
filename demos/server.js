const express = require('express');
const fs = require('fs');
const path = require('path');

if (typeof path.extname !== 'function') {
    path.extname = function(p) {
        const match = p.match(/\.[^/.]+$/);
        return match ? match[0] : '';
    };
}

const app = express();
const PORT = 3000;

app.get('*', (req, res) => {
    const requestedPath = req.path;
    console.log(`[Server] Request: ${requestedPath}`);
    
    const fileName = requestedPath === '/' ? 'index.html' : requestedPath;
    
    const filePath = path.join(process.cwd(), fileName);

    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg'
    };
    
    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            console.log(`[Server] 404: ${filePath}`);
            res.status(404).end(`<h1>404 Not Found</h1>`); // Use .end() here too
            return;
        }

        console.log(`[Server] 200: ${filePath}`);
        res.setHeader('Content-Type', contentType);
        
        res.end(content); 
    });
});

app.listen(PORT, () => {
    console.log(`Express server running at http://localhost:${PORT}`);
    console.log(`Serving: ${process.cwd()}`);
});
