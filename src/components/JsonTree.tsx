import { useEffect, useRef, useState, type ReactNode } from "react";

const mark = (text: string, term: string): ReactNode => {
  if (!term) return text;
  const lower = text.toLowerCase();
  const out: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, from)) {
    if (at > from) out.push(text.slice(from, at));
    out.push(
      <mark className="search-match-highlight" key={at}>
        {text.slice(at, at + term.length)}
      </mark>,
    );
    from = at + term.length;
  }
  if (from === 0) return text;
  if (from < text.length) out.push(text.slice(from));
  return out;
};

interface JsonTreeProps {
  value: unknown;
  name?: string | number;
  /** Lower-case search text to highlight in keys and values. */
  term?: string;
}

/** Collapsible JSON, fully expanded to start with: objects and arrays fold, scalars are coloured by type, matches of the search are marked. */
export function JsonTree({ value, name, term = "" }: JsonTreeProps): ReactNode {
  const key = name !== undefined ? <span className="jk">{mark(String(name), term)}</span> : null;
  const sep = name !== undefined ? ": " : "";
  if (value === null) {
    return (
      <div className="jt-line">
        {key}
        {sep}
        <span className="jl">{mark("null", term)}</span>
      </div>
    );
  }
  if (typeof value !== "object") {
    const cls = typeof value === "string" ? "js" : typeof value === "number" ? "jn" : "jb";
    return (
      <div className="jt-line">
        {key}
        {sep}
        <span className={cls}>{mark(JSON.stringify(value), term)}</span>
      </div>
    );
  }
  const isArray = Array.isArray(value);
  const entries: [string | number, unknown][] = isArray ? (value as unknown[]).map((v, i) => [i, v]) : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return (
      <div className="jt-line">
        {key}
        {sep}
        <span className="jl">{isArray ? "[]" : "{}"}</span>
      </div>
    );
  }
  return (
    <details open>
      <summary>
        {key}
        {sep}
        {isArray ? "[" : "{"}
        <span className="pv">
          {" "}
          {entries.length} {isArray ? "items" : "keys"} {isArray ? "]" : "}"}
        </span>
      </summary>
      {entries.map(([k, v]) => (
        <JsonTree key={k} name={isArray ? undefined : k} term={term} value={v} />
      ))}
      <div className="jt-close">{isArray ? "]" : "}"}</div>
    </details>
  );
}

/** `JsonTree` in its `.jt` frame, with a button that folds every nested branch or unfolds them all. */
export function JsonView({ value, term = "" }: { value: unknown; term?: string }): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  const [anyFolded, setAnyFolded] = useState(false);
  const nested = typeof value === "object" && value !== null && Object.values(value).some((v) => typeof v === "object" && v !== null && Object.keys(v).length > 0);

  // The label follows the real state of the tree, which the user can also change by clicking the carets.
  // The toggle event does not bubble, so it is caught in the capture phase.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const sync = () => setAnyFolded(Array.from(el.querySelectorAll("details")).some((d) => !d.open));
    el.addEventListener("toggle", sync, true);
    return () => el.removeEventListener("toggle", sync, true);
  }, []);

  const toggle = () => {
    const all = Array.from(root.current?.querySelectorAll("details") ?? []);
    // Unfold if anything is folded; otherwise fold everything below the root.
    const open = all.some((d) => !d.open);
    all.forEach((d, i) => {
      d.open = open || i === 0;
    });
  };

  return (
    <div className="jt" ref={root}>
      {nested ? (
        <button className="jt-toggle" onClick={toggle} type="button">
          {anyFolded ? "Expand all" : "Collapse all"}
        </button>
      ) : null}
      <JsonTree term={term} value={value} />
    </div>
  );
}
