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
  example - downloads the repo to the directory:  
  `gitclone https://github.com/mrhappynice/lifeman.git lifeman`

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

### Default entries and Lifeman link

A seed file ships at `/system/launcher.json` on first boot. It includes the Life Manager link.
When you click `Reindex` the first time, the launcher auto-populates any missing default entries (including the Life Manager card) into your config.

## Markdown preview in Nano

- Use `md /path/file.md` to open a file in preview mode.
- Toggle preview while editing with the `^M Preview` button.
- Code blocks include a Copy button.

## NPM and Express (inside the OS)

Use the built-in package manager to install and run Express.

1. Create a project folder:

```sh
mkdir /projects
cd /projects
```

2. Install Express:

```sh
npm install express
```

3. Create a server file:

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

4. Run the server:

```sh
run server.js
```

5. Open the browser app (launcher or command) and visit:

```
localhost:3000
```

## Dev - Deploying MHNOS notes

To ship defaults before deploying:

- Edit `demos/launcher.json` for launcher defaults.
- Add the file to `manifest.json` so boot installs it into OPFS.
- Add any static docs (like this README) to `manifest.json` and map them into `/demos/utils/`.