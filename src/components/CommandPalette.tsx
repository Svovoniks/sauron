import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fuzzyMatch } from "../lib/palette";
import { comboText } from "../lib/settings";
import { SearchIcon } from "./icons";

export type PaletteGroup = "Actions" | "Connections" | "Tabs" | "Saved queries" | "Tables" | "Settings";

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  icon: ReactNode;
  label: string;
  sub?: string;
  mono?: boolean;
  /** Shortcut label, already formatted. */
  kbd?: string;
  run: () => void;
}

const SCOPES: Record<string, { name: string; groups: PaletteGroup[] }> = {
  ">": { name: "commands", groups: ["Actions", "Settings"] },
  "@": { name: "connections", groups: ["Connections"] },
  "#": { name: "tables", groups: ["Tables"] },
};

interface CommandPaletteProps {
  items: PaletteItem[];
  initialQuery?: string;
  onClose: () => void;
}

const highlighted = (label: string, indexes: number[]): ReactNode => {
  if (indexes.length === 0) return label;
  const marks = new Set(indexes);
  const out: ReactNode[] = [];
  let run = "";
  let inMark = false;
  const flush = () => {
    if (run) out.push(inMark ? <b key={out.length}>{run}</b> : run);
    run = "";
  };
  [...label].forEach((char, i) => {
    const on = marks.has(i);
    if (on !== inMark) {
      flush();
      inMark = on;
    }
    run += char;
  });
  flush();
  return out;
};

export function CommandPalette({ items, initialQuery = "", onClose }: CommandPaletteProps) {
  const [raw, setRaw] = useState(initialQuery);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const scopeKey = /^[>@#]/.test(raw) ? raw[0] : "";
  const scope = scopeKey ? SCOPES[scopeKey] : null;
  const query = raw.slice(scopeKey ? 1 : 0).trim();

  const results = useMemo(() => {
    const pool = items.filter((item) => !scope || scope.groups.includes(item.group));
    const matched = pool
      .map((item) => {
        const m = fuzzyMatch(item.label, query);
        if (m) return { item, indexes: m.indexes, score: m.score };
        if (query.length > 2 && item.group !== "Tables" && item.group !== "Settings" && item.sub?.toLowerCase().includes(query.toLowerCase())) return { item, indexes: [] as number[], score: -1 };
        return null;
      })
      .filter((x): x is { item: PaletteItem; indexes: number[]; score: number } => x !== null);
    if (query) return matched.sort((a, b) => b.score - a.score).slice(0, 60);
    if (scope) return matched.slice(0, 60);
    // Empty palette: the useful groups first, a few tables, no settings.
    const tables = matched.filter((m) => m.item.group === "Tables").slice(0, 3);
    return [...matched.filter((m) => m.item.group !== "Settings" && m.item.group !== "Tables"), ...tables];
  }, [items, scope, query]);

  useEffect(() => setHighlight(0), [raw]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    listRef.current?.querySelector(".pal-item.hi")?.scrollIntoView({ block: "nearest" });
  }, [highlight, results]);

  const run = (index: number) => {
    const entry = results[index];
    if (!entry) return;
    onClose();
    // after the palette unmounts, so focus restoration cannot steal focus from what the command opens
    window.setTimeout(entry.item.run, 0);
  };

  let lastGroup = "";
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        aria-label="Command palette"
        aria-modal="true"
        className="palette"
        onKeyDown={(event) => {
          // Works wherever the focus is inside (e.g. after clicking the footer), and Tab never leaves the palette.
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === "Tab") {
            event.preventDefault();
            inputRef.current?.focus();
          }
        }}
        role="dialog"
      >
        <div className="pal-in">
          <SearchIcon />
          {scope ? <span className="pal-scope">{scope.name}</span> : null}
          <input
            aria-label="Command palette"
            onChange={(event) => setRaw(event.target.value)}
            onKeyDown={(event) => {
              // Ctrl+N / Ctrl+P move like the arrow keys (as in a terminal or Emacs).
              const emacs = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
              const down = event.key === "ArrowDown" || (emacs && event.key.toLowerCase() === "n");
              const up = event.key === "ArrowUp" || (emacs && event.key.toLowerCase() === "p");
              if (down) {
                event.preventDefault();
                setHighlight((h) => (results.length ? (h + 1) % results.length : 0));
              } else if (up) {
                event.preventDefault();
                setHighlight((h) => (results.length ? (h - 1 + results.length) % results.length : 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                run(highlight);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              } else if (event.key === "Backspace" && scope && query === "") {
                // removing the prefix character leaves scope mode
              }
            }}
            placeholder="Type a command, query, table or setting…"
            ref={inputRef}
            spellCheck={false}
            value={raw}
          />
          <kbd>esc</kbd>
        </div>
        <div className="pal-list" ref={listRef} role="listbox">
          {results.map(({ item, indexes }, index) => {
            const header = !query && !scope && item.group !== lastGroup ? <div className="pal-group">{(lastGroup = item.group)}</div> : null;
            return (
              <div key={item.id}>
                {header}
                <div
                  aria-selected={index === highlight}
                  className={`pal-item ${index === highlight ? "hi" : ""}`}
                  onClick={() => run(index)}
                  onMouseMove={() => index !== highlight && setHighlight(index)}
                  role="option"
                >
                  <span className="ic">{item.icon}</span>
                  <span className="pal-label">{highlighted(item.label, indexes)}</span>
                  {item.sub ? <span className={`sub ${item.mono ? "mono" : ""}`}>{item.sub}</span> : null}
                  <span className="sp" />
                  {query || scope ? <span className="pal-group-tag">{item.group}</span> : null}
                  {item.kbd ? <kbd>{item.kbd}</kbd> : null}
                </div>
              </div>
            );
          })}
          {results.length === 0 ? (
            <div className="pal-empty">
              Nothing matches. Try <kbd>&gt;</kbd> for commands, <kbd>@</kbd> connections, <kbd>#</kbd> tables.
            </div>
          ) : null}
        </div>
        <div className="pal-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> run
          </span>
          <span>
            <kbd>&gt;</kbd> commands
          </span>
          <span>
            <kbd>@</kbd> connections
          </span>
          <span>
            <kbd>#</kbd> tables
          </span>
        </div>
      </div>
    </div>
  );
}

export { comboText };
