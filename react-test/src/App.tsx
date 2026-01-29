import React, { useEffect, useMemo, useRef, useState } from "react";

const MEMORY_SYMBOLS = ["🚀", "⭐", "🪐", "👾", "🎮", "💎", "🛸", "⚡", "🔮", "🧩"];
const QUEST_CARDS = [
  {
    id: "q-1",
    title: "Neon Relay",
    detail: "Calibrate the city grid by syncing 3 relay towers.",
    tags: ["sync", "network", "timing"],
  },
  {
    id: "q-2",
    title: "Pixel Harvest",
    detail: "Collect 12 lumina shards before the night cycle ends.",
    tags: ["collection", "timer", "state"],
  },
  {
    id: "q-3",
    title: "Astro Courier",
    detail: "Route packages through 4 sectors without collision.",
    tags: ["routing", "effects", "path"],
  },
  {
    id: "q-4",
    title: "Synthwave Arena",
    detail: "Unlock the arena by winning 3 back-to-back rounds.",
    tags: ["streak", "score", "momentum"],
  },
  {
    id: "q-5",
    title: "Signal Hunter",
    detail: "Trace the hidden broadcast and decode the glyphs.",
    tags: ["search", "decode", "clues"],
  },
  {
    id: "q-6",
    title: "Glitch Patrol",
    detail: "Find and patch 5 anomalies in the data stream.",
    tags: ["debug", "streams", "alerts"],
  },
];

function shuffle<T>(items: T[]) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function formatMs(value: number) {
  return `${Math.max(0, Math.round(value))}ms`;
}

function formatTime(seconds: number) {
  const safe = Math.max(0, seconds);
  const min = Math.floor(safe / 60)
    .toString()
    .padStart(2, "0");
  const sec = Math.floor(safe % 60)
    .toString()
    .padStart(2, "0");
  return `${min}:${sec}`;
}

function SectionShell({
  id,
  title,
  subtitle,
  children,
}: {
  id: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="game-section">
      <header>
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <button
          type="button"
          className="chip"
          onClick={() => {
            document.getElementById("arcade-hub")?.scrollIntoView({ behavior: "smooth" });
          }}
        >
          Back to top
        </button>
      </header>
      <div className="game-body">{children}</div>
    </section>
  );
}

function ReactionGame() {
  const timeoutRef = useRef<number | null>(null);
  const goTimeRef = useRef(0);
  const [status, setStatus] = useState<
    "idle" | "wait" | "go" | "too-soon" | "result"
  >("idle");
  const [reaction, setReaction] = useState<number | null>(null);
  const [best, setBest] = useState<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (status !== "wait") return;
    const baseDelay = 1000;
    const variance = 900;
    timeoutRef.current = window.setTimeout(() => {
      goTimeRef.current = performance.now();
      setStatus("go");
    }, baseDelay + Math.random() * variance);
    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    };
  }, [status]);

  const handleTap = () => {
    if (status === "wait") {
      setStatus("too-soon");
      return;
    }
    if (status === "go") {
      const result = performance.now() - goTimeRef.current;
      setReaction(result);
      setBest((prev) => (prev === null ? result : Math.min(prev, result)));
      setStatus("result");
      return;
    }
    if (status === "idle" || status === "too-soon" || status === "result") {
      setReaction(null);
      setStatus("wait");
    }
  };

  return (
    <div className="reaction-game">
      <button type="button" className={`reaction-pad ${status}`} onClick={handleTap}>
        <div className="reaction-title">REFLEX TEST</div>
        <div className="reaction-status">
          {status === "idle" && "Tap to arm"}
          {status === "wait" && "Hold..."}
          {status === "go" && "GO"}
          {status === "too-soon" && "Too soon - tap to retry"}
          {status === "result" && "Nice! tap to play again"}
        </div>
        <div className="reaction-metrics">
          <span>Last: {reaction ? formatMs(reaction) : "--"}</span>
          <span>Best: {best ? formatMs(best) : "--"}</span>
        </div>
      </button>
      <div className="game-aside">
        <h4>React angle</h4>
        <p>
          Effects schedule the random delay, state drives the UI, and refs keep timer
          data without re-rendering.
        </p>
      </div>
    </div>
  );
}

function MemoryGame() {
  const [shuffleKey, setShuffleKey] = useState(0);
  const [flipped, setFlipped] = useState<number[]>([]);
  const [matched, setMatched] = useState<number[]>([]);
  const [moves, setMoves] = useState(0);
  const deck = useMemo(() => {
    const symbols = MEMORY_SYMBOLS.slice(0, 8);
    const cards = shuffle([...symbols, ...symbols]).map((symbol, index) => ({
      id: `${shuffleKey}-${index}`,
      symbol,
    }));
    return cards;
  }, [shuffleKey]);

  useEffect(() => {
    if (flipped.length !== 2) return;
    const [first, second] = flipped;
    const isMatch = deck[first]?.symbol === deck[second]?.symbol;
    const timeout = window.setTimeout(() => {
      if (isMatch) {
        setMatched((prev) => [...prev, first, second]);
      }
      setFlipped([]);
    }, 620);
    return () => window.clearTimeout(timeout);
  }, [flipped, deck]);

  const handleFlip = (index: number) => {
    if (flipped.includes(index) || matched.includes(index)) return;
    if (flipped.length >= 2) return;
    setFlipped((prev) => [...prev, index]);
    if (flipped.length === 1) setMoves((prev) => prev + 1);
  };

  const reset = () => {
    setFlipped([]);
    setMatched([]);
    setMoves(0);
    setShuffleKey((prev) => prev + 1);
  };

  return (
    <div className="memory-game">
      <div className="memory-grid">
        {deck.map((card, index) => {
          const isFlipped = flipped.includes(index) || matched.includes(index);
          return (
            <button
              key={card.id}
              type="button"
              className={`memory-card ${isFlipped ? "flipped" : ""}`}
              onClick={() => handleFlip(index)}
            >
              <span className="memory-front">?</span>
              <span className="memory-back">{card.symbol}</span>
            </button>
          );
        })}
      </div>
      <div className="game-aside">
        <div className="score-line">Moves: {moves}</div>
        <div className="score-line">Matches: {matched.length / 2} / 8</div>
        <button className="btn ghost" type="button" onClick={reset}>
          Remix deck
        </button>
        <p>
          React keeps the board consistent while state changes. Derived UI is
          memoized from the shuffle key.
        </p>
      </div>
    </div>
  );
}

function WhackGame() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(30);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!running) return;
    const tick = window.setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          setRunning(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(tick);
  }, [running]);

  useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => {
      setActiveIndex(Math.floor(Math.random() * 16));
    }, 600);
    return () => window.clearInterval(interval);
  }, [running]);

  const start = () => {
    setScore(0);
    setTimeLeft(30);
    setRunning(true);
  };

  const hit = (index: number) => {
    if (!running) return;
    if (index === activeIndex) {
      setScore((prev) => prev + 1);
    } else {
      setScore((prev) => Math.max(0, prev - 1));
    }
  };

  return (
    <div className="whack-game">
      <div className="whack-grid">
        {Array.from({ length: 16 }).map((_, index) => (
          <button
            key={index}
            type="button"
            className={`whack-cell ${running && index === activeIndex ? "hot" : ""}`}
            onClick={() => hit(index)}
          >
            <span>{running && index === activeIndex ? "TARGET" : ""}</span>
          </button>
        ))}
      </div>
      <div className="game-aside">
        <div className="score-line">Score: {score}</div>
        <div className="score-line">Time: {formatTime(timeLeft)}</div>
        <button className="btn" type="button" onClick={start}>
          {running ? "Restart" : "Start"}
        </button>
        <p>
          Timers, intervals, and state transitions show React effects in motion.
        </p>
      </div>
    </div>
  );
}

function NeonMixer() {
  const [red, setRed] = useState(120);
  const [green, setGreen] = useState(210);
  const [blue, setBlue] = useState(255);
  const [glow, setGlow] = useState(18);

  const hex = useMemo(() => {
    const toHex = (value: number) => value.toString(16).padStart(2, "0");
    return `#${toHex(red)}${toHex(green)}${toHex(blue)}`.toUpperCase();
  }, [red, green, blue]);

  const rarity = useMemo(() => {
    const sum = red + green + blue;
    if (sum > 620) return "legendary";
    if (sum > 520) return "ultra";
    if (sum > 420) return "rare";
    if (sum > 320) return "boosted";
    return "starter";
  }, [red, green, blue]);

  return (
    <div className="mixer-game">
      <div className="mixer-preview" style={{ background: hex, boxShadow: `0 0 ${glow}px ${hex}` }}>
        <div className="mixer-label">{hex}</div>
        <div className={`mixer-rarity ${rarity}`}>{rarity}</div>
      </div>
      <div className="mixer-controls">
        <label>
          Red {red}
          <input
            type="range"
            min={0}
            max={255}
            value={red}
            onChange={(event) => setRed(Number(event.target.value))}
          />
        </label>
        <label>
          Green {green}
          <input
            type="range"
            min={0}
            max={255}
            value={green}
            onChange={(event) => setGreen(Number(event.target.value))}
          />
        </label>
        <label>
          Blue {blue}
          <input
            type="range"
            min={0}
            max={255}
            value={blue}
            onChange={(event) => setBlue(Number(event.target.value))}
          />
        </label>
        <label>
          Glow {glow}
          <input
            type="range"
            min={4}
            max={40}
            value={glow}
            onChange={(event) => setGlow(Number(event.target.value))}
          />
        </label>
      </div>
      <div className="game-aside">
        <p>
          Derived UI uses memoization for hex and rarity. Sliders stream new state and
          React redraws instantly.
        </p>
      </div>
    </div>
  );
}

function QuestLog() {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return QUEST_CARDS;
    return QUEST_CARDS.filter((card) => {
      const haystack = `${card.title} ${card.detail} ${card.tags.join(" ")}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [query]);

  return (
    <div className="quest-game">
      <div className="quest-board">
        <div className="quest-controls">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search quests (instant)"
          />
          <div className="quest-count">
            Showing {filtered.length} of {QUEST_CARDS.length}
          </div>
        </div>
        <div className="quest-grid">
          {filtered.map((card) => (
            <div key={card.id} className="quest-card">
              <div>
                <h4>{card.title}</h4>
                <p>{card.detail}</p>
              </div>
              <div className="quest-tags">
                {card.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="quest-empty">No matches. Try a different keyword.</div>
          )}
        </div>
      </div>
      <div className="game-aside">
        <p>
          Instant lexical filtering shows how state updates and derived lists keep the UI in
          sync. Try typing “signal”, “timer”, or “debug”.
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const sections = [
    {
      id: "reflex",
      title: "Reflex Test",
      subtitle: "Click on green. Miss it and it resets.",
      content: <ReactionGame />,
    },
    {
      id: "memory",
      title: "Memory Vault",
      subtitle: "Flip two cards at a time and lock in the matches.",
      content: <MemoryGame />,
    },
    {
      id: "whack",
      title: "Target Rush",
      subtitle: "Score points by hitting the hot tile before it jumps.",
      content: <WhackGame />,
    },
    {
      id: "mixer",
      title: "Neon Mixer",
      subtitle: "Blend RGB light. Derived stats update live.",
      content: <NeonMixer />,
    },
    {
      id: "quests",
      title: "Quest Log",
      subtitle: "Use refs to control focus and quick state updates.",
      content: <QuestLog />,
    },
  ];

  return (
    <div className="arcade">
      <header id="arcade-hub" className="hero">
        <div className="hero-text">
          <div className="hero-eyebrow">React Arcade</div>
          <h1>Five mini games that show why React is fun</h1>
          <p>
            Each game highlights a React strength: state, effects, refs, and
            memoization.
          </p>
        </div>
      </header>

      {sections.map((section) => (
        <SectionShell
          key={section.id}
          id={section.id}
          title={section.title}
          subtitle={section.subtitle}
        >
          {section.content}
        </SectionShell>
      ))}

      <footer className="footer">
        <div>React Arcade - mini games for state, effects, and composition.</div>
        <div>Built in React with hooks.</div>
      </footer>
    </div>
  );
}
