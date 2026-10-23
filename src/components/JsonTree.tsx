import type { ReactNode } from "react";

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

/** Does any key or scalar below `value` contain `term` (lower-case)? Used to open folded branches that hold a match. */
const contains = (value: unknown, term: string): boolean => {
  if (value === null) return "null".includes(term);
  if (typeof value !== "object") return String(value).toLowerCase().includes(term);
  const entries: [string, unknown][] = Array.isArray(value) ? [] : Object.entries(value as Record<string, unknown>);
  if (Array.isArray(value)) return value.some((item) => contains(item, term));
  return entries.some(([key, inner]) => key.toLowerCase().includes(term) || contains(inner, term));
};

interface JsonTreeProps {
  value: unknown;
  depth?: number;
  name?: string | number;
  /** Lower-case search text to highlight in keys and values. */
  term?: string;
}

/** Collapsible JSON: objects and arrays fold, scalars are coloured by type, matches of the search are marked. */
export function JsonTree({ value, depth = 0, name, term = "" }: JsonTreeProps): ReactNode {
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
    <details open={depth < 3 || (term !== "" && contains(value, term))}>
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
        <JsonTree depth={depth + 1} key={k} name={isArray ? undefined : k} term={term} value={v} />
      ))}
      <div className="jt-close">{isArray ? "]" : "}"}</div>
    </details>
  );
}
