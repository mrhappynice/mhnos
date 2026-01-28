# Sandpack Dev Tool Integration Plan (MHNOS)

## Goal
Add Sandpack as an **optional dev preview tool** that provides fast HMR and npm support without replacing the existing OPFS + SW pipeline. Sandpack runs in its own iframe and virtual FS; we sync files between OPFS and Sandpack for live preview.

---

## Architecture Overview
- **Source of truth:** OPFS (existing MHNOS filesystem)
- **Dev preview:** Sandpack iframe + virtual FS
- **Sync direction:**
  - OPFS → Sandpack (for preview)
  - Sandpack → OPFS (optional, for editor-driven edits)

---

## UI/UX
- Add a **"Dev Preview (Sandpack)"** app/window:
  - Left: file tree + editor (optional if you already have editor)
  - Right: Sandpack preview iframe
- Add a toggle to enable/disable Sandpack per project.

---

## Core Integration Steps

### 1) Add Sandpack Runtime Assets
- Load Sandpack runtime via CDN in a new app window (or bundle locally later).
- Keep it isolated from your SW fetch pipeline.

### 2) Create Sandpack Host App
- New app at `/apps/dev-preview/`:
  - `index.html`
  - `src/main.tsx` (or JS)
- Use Sandpack React components or Sandpack client API.

### 3) OPFS → Sandpack Sync
- Read OPFS files for the project:
  - `/apps/<name>/src/**`
  - `/apps/<name>/index.html`
  - `/apps/<name>/package.json`
- Build Sandpack `files` object:
  ```js
  {
    "/index.html": "...",
    "/src/main.tsx": "...",
    "/src/App.tsx": "...",
    "/src/styles.css": "...",
    "/package.json": "..."
  }
  ```
- Push into Sandpack with `client.updateSandbox({ files })`.

### 4) Sandpack → OPFS Sync (Optional)
- Listen to Sandpack file changes (client events).
- When a file changes in Sandpack, write it back to OPFS.
- Debounce writes (e.g., 300–500ms).

### 5) File Change Notifications
- When OPFS files change (your editor writes), notify Sandpack and update files.
- You already send `FS_FILE_CHANGED` to SW; reuse that pattern.

### 6) Project Selection
- Add a dropdown or input for active project path.
- On change, reload Sandpack with that project’s files.

---

## Sandpack API Choices

### Option A: React Components (Simpler UI)
- Use `@codesandbox/sandpack-react`.
- Works well if your OS UI already uses React.

### Option B: Sandpack Client API (More control)
- Use `@codesandbox/sandpack-client`.
- Create an iframe and control it programmatically.
- Best if you want custom layout and less React coupling.

---

## Handling Dependencies
- Sandpack uses `package.json` to resolve npm deps.
- Normalize `package.json` before sending to Sandpack:
  - Ensure **ESM-friendly exports** when possible.
  - Prefer packages with ESM entry points or `exports` that include ESM.
  - Optionally set `"type": "module"` for clarity.
- If `package.json` is missing, generate a minimal one.
- Optionally auto-add `react` + `react-dom` for React apps.

---

## Limitations / Notes
- Sandpack FS is virtual; OPFS remains authoritative.
- Sandpack HMR won’t apply to your SW pipeline (it’s a separate preview).
- Large repos might need file filtering or lazy sync.

---

## Next Steps (Tomorrow)
1) Pick **Sandpack React** or **Client API** route.
2) Build minimal `/apps/dev-preview` app.
3) Implement OPFS → Sandpack sync.
4) Add optional Sandpack → OPFS sync.

