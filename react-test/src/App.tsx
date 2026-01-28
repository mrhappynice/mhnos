import React, { useMemo, useState } from "react";

const KERNEL_LINES = [
  "MHNOS Kernel v0.6.1 Ready",
  "OPFS mounted",
  "SW online",
  "Dev server: hot module graph",
  "Graphics: window manager active",
  "RPC: fs.readFile OK",
];

function timeAgo(ts: number) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

export default function App() {
  const [bootTs] = useState(() => Date.now());
  const [ticker, setTicker] = useState(0);

  React.useEffect(() => {
    const id = setInterval(() => setTicker((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const log = useMemo(() => {
    const lines = [...KERNEL_LINES];
    if (ticker % 2 === 0) lines.push("Renderer: composited frame");
    if (ticker % 3 === 0) lines.push("Cache: deps warmed");
    if (ticker % 5 === 0) lines.push("Session: autosave checkpoint");
    return lines.slice(-6);
  }, [ticker]);

  return (
    <div className="app">
      <header className="hero">
        <div className="orb" aria-hidden="true" />
        <div>
          <p className="eyebrow">MHNOS / React Test</p>
          <h1>Night‑mode dev cockpit</h1>
          <p className="subhead">
            A tiny dashboard to show off the OS vibe: a live kernel feed, quick actions,
            and a soft glow layout that’s easy on the eyes.
          </p>
        </div>
      </header>

      <section className="grid">
        <div className="card terminal">
          <div className="card-head">
            <span>Kernel Feed</span>
            <span className="pill">uptime {timeAgo(bootTs)}</span>
          </div>
          <div className="log">
            {log.map((line, i) => (
              <div key={`${line}-${i}`} className="log-line">
                <span className="dot" />
                <span>{line}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <span>Quick Actions</span>
          </div>
          <div className="actions">
            <button className="btn">Launch /apps/hello</button>
            <button className="btn ghost">Open Files</button>
            <button className="btn ghost">New Project</button>
          </div>
          <div className="stats">
            <div>
              <span className="label">Workspaces</span>
              <strong>3</strong>
            </div>
            <div>
              <span className="label">Packages</span>
              <strong>42</strong>
            </div>
            <div>
              <span className="label">Windows</span>
              <strong>5</strong>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <span>System Mood</span>
          </div>
          <div className="meter">
            <div className="bar">
              <div className="fill" style={{ width: `${60 + (ticker % 20)}%` }} />
            </div>
            <p className="muted">Low noise, high focus.</p>
          </div>
          <div className="chips">
            <span>OPFS</span>
            <span>SW</span>
            <span>Vite‑style</span>
            <span>React 18</span>
          </div>
        </div>
      </section>

      <footer className="footer">
        <span>Built for MHNOS dev flow</span>
        <span className="sep">•</span>
        <span>Dark mode first</span>
        <span className="sep">•</span>
        <span>Powered by OPFS + SW</span>
      </footer>
    </div>
  );
}
