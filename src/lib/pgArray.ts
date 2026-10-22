export type PgArray = (string | null | PgArray)[];

const MAX_DEPTH = 256;

const isWs = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";

/**
 * Parses a Postgres array text literal such as `{1,2}`, `{"a b",NULL}` or `{{1,2},{3,4}}`.
 * Elements stay strings; unquoted NULL (any case) becomes null. A leading dimension decoration
 * like `[0:2]=` is accepted and ignored. Returns null for malformed input; never throws.
 */
export function parsePgArray(text: string): PgArray | null {
  if (typeof text !== "string") return null;
  const n = text.length;
  let i = 0;

  const skipWs = () => {
    while (i < n && isWs(text[i])) i++;
  };

  skipWs();
  if (text[i] === "[") {
    const m = /^(?:\[[^\]=]*\])+=/.exec(text.slice(i));
    if (!m) return null;
    i += m[0].length;
    skipWs();
  }

  const parseQuoted = (): string | null => {
    // text[i] is the opening quote.
    i++;
    let out = "";
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        if (i + 1 >= n) return null;
        out += text[i + 1];
        i += 2;
      } else if (c === '"') {
        i++;
        return out;
      } else {
        out += c;
        i++;
      }
    }
    return null;
  };

  const parseUnquoted = (): string | null | undefined => {
    // Returns undefined on an empty/invalid element.
    let out = "";
    let keep = 0;
    let escaped = false;
    while (i < n) {
      const c = text[i];
      if (c === "," || c === "}" || c === "{" || c === '"') break;
      if (c === "\\") {
        if (i + 1 >= n) return undefined;
        out += text[i + 1];
        keep = out.length;
        escaped = true;
        i += 2;
      } else {
        out += c;
        if (!isWs(c)) keep = out.length;
        i++;
      }
    }
    const value = out.slice(0, keep);
    if (value === "") return undefined;
    if (!escaped && value.toLowerCase() === "null") return null;
    return value;
  };

  const parseArray = (depth: number): PgArray | null => {
    if (depth > MAX_DEPTH || text[i] !== "{") return null;
    i++;
    const result: PgArray = [];
    skipWs();
    if (text[i] === "}") {
      i++;
      return result;
    }
    for (;;) {
      skipWs();
      const c = text[i];
      if (c === undefined) return null;
      if (c === "{") {
        const nested = parseArray(depth + 1);
        if (nested === null) return null;
        result.push(nested);
      } else if (c === '"') {
        const value = parseQuoted();
        if (value === null) return null;
        result.push(value);
      } else {
        const value = parseUnquoted();
        if (value === undefined) return null;
        result.push(value);
      }
      skipWs();
      const next = text[i];
      i++;
      if (next === "}") return result;
      if (next !== ",") return null;
    }
  };

  const result = parseArray(0);
  if (result === null) return null;
  skipWs();
  return i === n ? result : null;
}
