import { useMemo, useState } from 'react';

const TAGS = ['oapp', 'vite-style', 'module-graph', 'no-build', 'react-18'];

export default function App() {
  const [count, setCount] = useState(2);
  const [log, setLog] = useState(['Booted oapp demo.']);

  const displayCount = useMemo(() => Math.max(count, 0), [count]);

  function handleAdd(step) {
    setCount((prev) => prev + step);
    setLog((prev) => [`Changed by ${step > 0 ? '+' : ''}${step}.`, ...prev].slice(0, 6));
  }

  return (
    <div className="app">
      <section className="card">
        <h1>React OApp Demo</h1>
        <p className="subtitle">
          Minimal multi-file React app running through the oapp module loader.
        </p>
        <div className="pill-row">
          {TAGS.map((tag) => (
            <span className="pill" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      </section>

      <section className="card panel">
        <div className="counter">
          <strong>Counter:</strong>
          <span>{displayCount}</span>
        </div>
        <div className="counter">
          <button onClick={() => handleAdd(1)}>+1</button>
          <button onClick={() => handleAdd(5)}>+5</button>
          <button onClick={() => handleAdd(-1)}>-1</button>
        </div>
        <div>
          <strong>Recent actions</strong>
          <ul className="log">
            {log.map((entry, index) => (
              <li key={index}>{entry}</li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
