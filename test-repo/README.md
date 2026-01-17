# MHNOS Control Hub (Two-Server Walkthrough)

A walkthrough repo that runs two servers inside MHNOS and exposes a dark, interactive control hub UI. The control server renders the UI and calls worker actions (parse/generate/remote/search/write). The worker server exposes a JSON API for direct access and verification.

## Why two servers?

- **Control Server (3000):** Hosts the UI and renders results.
- **Worker Server (4000):** Performs the heavy work (parse, generate, fetch, search).

Because the OS browser only loads pages through the built-in address bar, the UI uses the URL bar to trigger actions. This keeps everything compatible with MHNOS loopback networking.

## Quick Start

```sh
cd /test-repo
npm install
```

Start both servers (two processes):

```sh
run servers/worker.js
run servers/control.js
```

Or start both with one command:

```sh
run servers/start.js
```

Open the UI:

```sh
browser
```

Then set the URL to:

```
localhost:3000
```

## Using the Control Hub

1) Click any action button to build an action URL.
2) Copy it, paste it into the OS browser address bar, and press Go.
3) The page reloads with the worker response rendered.

Example URLs:

```
localhost:3000/?action=parse&format=csv
localhost:3000/?action=generate
localhost:3000/?action=remote&url=https://jsonplaceholder.typicode.com/todos/1
localhost:3000/?action=search&query=nova
localhost:3000/?action=write
```

## Direct Worker API

You can also hit the worker server directly from the URL bar:

```
localhost:4000/action?action=parse&format=json
localhost:4000/action?action=remote&url=https://jsonplaceholder.typicode.com/todos/1
```

## Remote Fetch Demo

The worker fetches remote JSON and returns a summary. Default URL:

```
https://jsonplaceholder.typicode.com/todos/1
```

You can replace it with other public JSON endpoints that allow CORS.

## Notes

- The UI is server-rendered to stay compatible with MHNOS browser networking.
- Worker writes are returned as output so you can save them into OPFS with `edit` or `nano`.
- Sample data lives in `/test-repo/data`.
