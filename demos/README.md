# MHNOS Prototype

This is a browser-based MHNOS prototype with a window manager, shell, OPFS-backed filesystem, and a launcher with instant search.

## Quick Start

- Open the page and the Launcher will appear on load.
- Use the shell at the bottom for commands.
- Use the minimize dock on the right to restore minimized windows.

## Shell Basics

Common commands:

- `help` - list commands
- `ls` - list files
- `cd <path>` - change directory
- `mkdir <name>` - create directory
- `rm <path>` - remove file/dir
- `upload` - upload files from your computer
- `cat <file>` - print file
- `edit <file>` - open Nano editor
- `md <file>` - open Markdown preview mode
- `run <file>` - run a JS process
- `browser` - open the internal browser app
- `files` - open the file explorer
- `launcher` - open the launcher
- `gitclone` - download github repo
- `backup` - manage encrypted backups (local zip or S3-compatible)
- `appbuilder` - create your own apps, local and api models
- `oapp` - launcher your app creations 

## Filesystem (OPFS)

The OS stores files in the browser's Origin Private File System (OPFS).

Add files:

- **Upload Files**: Type `upload` to open the native file picker and select one or more files. They will be saved to your current directory.
- **Upload Folders**: Type `upload folder` to select a directory. This preserves the folder structure and uploads all files inside.
- **Create**: Use `edit /path/file.txt` to create or edit a file manually.
- **Make Dirs**: Use `mkdir /path/folder` for new folders.

Search files:

- Use the Launcher search input for instant lexical search across text files (code, md, json, txt, etc.).
- Click any search result to open it in the editor.

## Backup and Restore

Backups are encrypted in the browser with AES-GCM and a passphrase you enter each time (the passphrase is never stored).

### Configure remote (S3-compatible)

```sh
backup config set
```

Then fill in:

- endpoint (R2 or MinIO URL)
- bucket
- region (use `auto` for R2)
- access key / secret
- optional prefix

Show config:

```sh
backup config show
```

### Remote backup/restore

```sh
backup push
backup list
backup pull
```

### Local zip backup/restore

```sh
backup local push
backup local pull
```

Notes:

- Local backups are stored as a `.zip` with no compression for speed.
- Each file is encrypted and stored in the zip alongside a `backup.json` manifest.

### CORS setup (browser access)

Cloudflare R2 (JSON in dashboard):

```json
[
  {
    "AllowedOrigins": ["https://your-origin.example"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

MinIO (JSON for `mc cors set` or console):

```json
[
  {
    "AllowedOrigins": ["https://your-origin.example"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Notes:

- Use your exact app origin (including scheme + port).
- R2 endpoint format: `https://<accountid>.r2.cloudflarestorage.com`
- MinIO endpoint format: `https://<host>:<port>`

## Launcher

The launcher supports quick-launch cards and instant search.

Add entries:

- Edit `/system/launcher.json`.
- Click `Reindex` in the launcher to reload and refresh cards.

Supported entry types:

- `app`: run a shell command
- `script`: run a JS file
- `url`: open a real browser tab
- `markdown`: open a file in Markdown preview mode

Example entry:

```json
{ "id": "docs", "label": "Docs", "type": "markdown", "path": "/docs/readme.md", "icon": "📘" }
```

### Default entries and reindexing

A seed file ships at `/system/launcher.json` on first boot.
When you click `Reindex` the first time, the launcher auto-populates any missing default entries into your config.

## Markdown preview in Nano

- Use `md /path/file.md` to open a file in preview mode.
- Toggle preview while editing with the `^M Preview` button.
- Code blocks include a Copy button.

## NPM and Express (inside the OS)

Use the built-in package manager to install and run Express.

1) Create a project folder:

```sh
mkdir /projects
cd /projects
```

2) Install Express:

```sh
npm install express
```

3) Create a server file:

```sh
edit server.js
```

Example server:

```js
const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send('Hello from MHNOS');
});

app.listen(3000, () => {
  console.log('Server listening on 3000');
});
```

4) Run the server:

```sh
run server.js
```

## Test Servers Demo Repo

You can pull the two-server Control Hub demo via gitclone:

```sh
gitclone https://github.com/mrhappynice/mhnos-test-servers.git test-repo
```

Start the servers (two processes):

```sh
cd /test-repo
npm install
run servers/worker.js
run servers/control.js
```

Open the UI:

```sh
browser
```

Then set the URL to:

```
localhost:3000
```

Notes:

- The Control server hosts the UI (port 3000).
- The Worker server exposes the JSON API (port 4000).
- Actions on the UI trigger worker tasks like parse, generate, search, and remote fetch.

### Build your own servers

Use these patterns to create new services:

1) Make a simple server file:

```js
const http = require('http');

http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Hello from MHNOS');
}).listen(3000);
```

2) Run it:

```sh
run server.js
```

3) Open it in the browser:

```
localhost:3000
```

Tip: to add dependencies, create `package.json` and use `npm install` in that directory to install all dependencies listed there.

5) Open the browser app (launcher or command) and visit:

```
localhost:3000
```

## 

## Creating your own apps - using oapp

Simply have a local model running or use a provider like OpenRouter, OpenAI etc, then tell the App Builder what type of app you would like. It generates the code and shows the rendered page. 

## How to launch an app now outside App Builder

If you generated:

```
/apps/todo/
  index.html
  styles.css
  app.js
```

Run:

```
oapp /apps/todo
```

That’s it.

---

## Make it easy from the Launcher (optional)

The Launcher already supports `type: "script"` and `type: "app"` (shell command). So to add a tile for a generated app, add an item in `/system/launcher.json` like:

```json
{
  "id": "todo",
  "label": "Todo App",
  "type": "app",
  "command": "oapp /apps/todo",
  "icon": "✅"
}
```

---



## Dev - Deploying MHNOS notes

To ship defaults before deploying:

- Edit `demos/launcher.json` for launcher defaults.
- Add the file to `manifest.json` so boot installs it into OPFS.
- Add any static docs (like this README) to `manifest.json` and map them into `/demos/utils/`.
