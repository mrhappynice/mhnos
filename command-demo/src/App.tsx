import React, { useMemo, useState } from "react";

type Step = {
  id: string;
  title: string;
  summary: string;
  commands: string[];
  notes?: string[];
  outcome?: string;
};

const STEPS: Step[] = [
  {
    id: "clone",
    title: "Get the demo repo (optional)",
    summary:
      "Pull this exact demo into OPFS with one command. Everything stays inside your web OS.",
    commands: ["gitclone https://github.com/mrhappynice/react-test.git /apps/react-test"],
    notes: ["Already here? Skip this and keep going."],
  },
  {
    id: "init",
    title: "Scaffold a fresh app",
    summary:
      "Create a new React app in seconds. The OS generates a Vite-style structure.",
    commands: ["oapp init /apps/hello"],
    outcome: "Creates index.html, src/main.tsx, src/App.tsx, src/styles.css",
  },
  {
    id: "install",
    title: "Install React",
    summary:
      "Use the OS package manager to install React and React DOM into OPFS.",
    commands: ["cd /apps/hello", "npm install react react-dom"],
    notes: ["Install once, cached locally for fast re-use."],
  },
  {
    id: "edit",
    title: "Edit the app",
    summary:
      "Open the built-in editor and customize your UI with React components.",
    commands: ["edit /apps/hello/src/App.tsx", "edit /apps/hello/src/styles.css"],
    notes: ["Use components + state to build UI that HTML alone cannot."],
  },
  {
    id: "run",
    title: "Run inside the OS",
    summary:
      "Launch it in its own window, powered by the web OS runtime.",
    commands: ["oapp /apps/hello"],
    notes: ["This uses the OS service worker and OPFS file system."],
  },
  {
    id: "build",
    title: "Bundle for export",
    summary:
      "Bundle everything into dist/ with one command using the built-in bundler.",
    commands: ["oapp build /apps/hello"],
    outcome: "Outputs /apps/hello/dist with optimized assets",
  },
  {
    id: "export",
    title: "Export to host device",
    summary:
      "Create a portable zip and run it anywhere on your host device.",
    commands: ["backup local export /apps/hello/dist"],
    notes: ["Unzip it on your host, then serve with any static server."],
  },
  {
    id: "serve",
    title: "Serve inside the web OS",
    summary:
      "Run the built output with a tiny server and open it in the OS browser.",
    commands: [
      "# Copy /demos/site/server.js into /apps/hello/dist",
      "run /apps/hello/dist/server.js",
      "browser",
    ],
    notes: [
      "A future command: site here (installs express + copies server.js).",
      "Then open http://localhost:3000 in the Browser app.",
    ],
  },
];

const REACT_POINTS = [
  {
    title: "Stateful UI",
    body:
      "UI updates automatically when state changes. No manual DOM wiring required.",
  },
  {
    title: "Reusable components",
    body: "Build once, reuse everywhere. Cleaner than copy-paste HTML blocks.",
  },
  {
    title: "Conditional rendering",
    body: "Show, hide, and swap UI based on app state and user intent.",
  },
  {
    title: "Data-driven lists",
    body: "Render collections reliably with filters, sorting, and dynamic updates.",
  },
];

const SAMPLE_TASKS = [
  "Ship the Hello app",
  "Add a markdown preview",
  "Wire the launcher",
  "Export dist/ build",
  "Open in Browser app",
  "Share with a teammate",
];

function CopyButton({ value }: { value: string }) {
  const [status, setStatus] = useState("Copy");

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("Copied");
      window.setTimeout(() => setStatus("Copy"), 1200);
    } catch (err) {
      setStatus("Select");
      window.setTimeout(() => setStatus("Copy"), 1200);
    }
  };

  return (
    <button className="copy" type="button" onClick={onCopy}>
      {status}
    </button>
  );
}

export default function App() {
  const [filter, setFilter] = useState("");
  const [showHints, setShowHints] = useState(true);
  const [count, setCount] = useState(0);

  const tasks = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return SAMPLE_TASKS;
    return SAMPLE_TASKS.filter((task) => task.toLowerCase().includes(q));
  }, [filter]);

  return (
    <div className="app">
      <header className="hero">
        <div className="hero-badge">OApp Workflow Demo</div>
        <h1>Build, run, and export React apps inside your web OS.</h1>
        <p className="subhead">
          This guided flow shows how an isolated dev environment can scaffold, edit,
          bundle, and ship a React app without leaving the browser.
        </p>
        <div className="hero-actions">
          <button className="btn" onClick={() => setCount((n) => n + 1)}>
            React state +1 ({count})
          </button>
          <button className="btn ghost" onClick={() => setShowHints((v) => !v)}>
            {showHints ? "Hide" : "Show"} helper tips
          </button>
        </div>
      </header>

      <section className="overview">
        <div className="card glow">
          <h3>Why React here?</h3>
          <p>
            React shines when UI changes frequently. In a dev OS, stateful panels,
            realtime logs, and dynamic previews are simpler when UI = f(state).
          </p>
          <div className="chips">
            <span>Stateful UI</span>
            <span>Components</span>
            <span>Realtime</span>
            <span>Composable</span>
          </div>
        </div>
        <div className="card">
          <h3>What the OS gives you</h3>
          <ul>
            <li>OPFS-backed file system and package cache</li>
            <li>Windowed apps: editor, terminal, browser</li>
            <li>One-command build + export pipeline</li>
          </ul>
        </div>
        <div className="card">
          <h3>What you ship</h3>
          <ul>
            <li>Local app in a window (oapp)</li>
            <li>Bundled dist/ assets</li>
            <li>Portable export zip for host device</li>
          </ul>
        </div>
      </section>

      <section className="steps">
        <div className="section-head">
          <h2>Step-by-step OApp flow</h2>
          <p>Copy a command, run it in the OS shell, and watch your app appear.</p>
        </div>

        <div className="step-grid">
          {STEPS.map((step, index) => (
            <article className="step card" key={step.id}>
              <div className="step-head">
                <span className="step-num">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.summary}</p>
                </div>
              </div>

              <div className="command-list">
                {step.commands.map((cmd, idx) => (
                  <div className="command" key={`${step.id}-${idx}`}>
                    <code>{cmd}</code>
                    {!cmd.startsWith("#") && <CopyButton value={cmd} />}
                  </div>
                ))}
              </div>

              {step.outcome && <div className="outcome">{step.outcome}</div>}

              {showHints && step.notes && (
                <ul className="notes">
                  {step.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="react-why">
        <div className="section-head">
          <h2>Why React over plain HTML?</h2>
          <p>Try the mini demo below. Everything updates instantly from state.</p>
        </div>

        <div className="react-grid">
          <div className="card">
            <div className="react-points">
              {REACT_POINTS.map((point) => (
                <div className="react-point" key={point.title}>
                  <h4>{point.title}</h4>
                  <p>{point.body}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="card demo">
            <div className="demo-head">
              <div>
                <h3>Live React state</h3>
                <p>Filter tasks, toggle UI, and watch the list update.</p>
              </div>
              <div className="pill">{tasks.length} tasks</div>
            </div>

            <label className="field">
              Filter tasks
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="type to filter"
              />
            </label>

            <div className="task-list">
              {tasks.map((task) => (
                <div key={task} className="task">
                  <span className="dot" />
                  <span>{task}</span>
                </div>
              ))}
              {!tasks.length && (
                <div className="empty">No matches. Try a different filter.</div>
              )}
            </div>

            <div className="demo-actions">
              <button className="btn" onClick={() => setFilter("")}>Reset filter</button>
              <button className="btn ghost" onClick={() => setShowHints((v) => !v)}>
                Toggle hints
              </button>
            </div>
          </div>
        </div>
      </section>

      <footer className="footer">
        <div>
          <strong>Tip:</strong> Use the OS Launcher to reopen this guide anytime.
        </div>
        <div className="footer-meta">MHN OS dev workflow - React + OPFS + ESBuild</div>
      </footer>
    </div>
  );
}
