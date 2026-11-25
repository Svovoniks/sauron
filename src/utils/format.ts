import { parsePgArray } from "../lib/pgArray";
import type { Cell } from "../types/app";

/** What the table / detail view shows for a cell. NULL is shown as the word "null". */
export const cellText = (value: Cell, nullText = "null"): string => (value === null ? nullText : value);

/**
 * Longest text a table cell puts into the page. A cell shows one line, a few hundred characters at most, but a json or
 * text column can hold megabytes; laying all of that out freezes the window for a moment when a result appears.
 * The record view and search still use the full value.
 */
export const CELL_DISPLAY_CHARS = 300;

export const clipCell = (text: string): string => (text.length > CELL_DISPLAY_CHARS ? `${text.slice(0, CELL_DISPLAY_CHARS)}…` : text);

export type ValueKind = "null" | "boolean" | "number" | "json" | "string";

export interface DetailValue {
  kind: ValueKind;
  /** Label shown next to the column name, e.g. "number", "timestamp tz". */
  label: string;
  /** What the value box shows (pretty-printed for json / arrays). */
  text: string;
  /** What the copy button puts on the clipboard. */
  copyText: string;
}

/**
 * Re-indents JSON text with two spaces. Values are copied character for character, never parsed, so numbers such as
 * 18446744073709551615 keep every digit and string escapes stay as written. The input must already be valid JSON.
 */
export function indentJson(text: string): string {
  let out = "";
  let depth = 0;
  const newline = () => `\n${"  ".repeat(depth)}`;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end;
    } else if (ch === "{" || ch === "[") {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === (ch === "{" ? "}" : "]")) {
        out += ch + text[next];
        i = next;
      } else {
        depth++;
        out += ch + newline();
      }
    } else if (ch === "}" || ch === "]") {
      depth--;
      out += newline() + ch;
    } else if (ch === ",") {
      out += ch + newline();
    } else if (ch === ":") {
      out += ": ";
    } else if (!/\s/.test(ch)) {
      out += ch;
    }
  }
  return out;
}

/** Pretty JSON text, or null when the text is not valid JSON. */
export const prettyJson = (text: string): string | null => {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  return indentJson(text);
};

/**
 * Formatting is driven by the column type reported by the database, never by sniffing the value:
 * a text column containing "18446744073709551615" or "1.50" must be shown exactly as stored.
 */
export function detailValue(type: string, value: Cell, options: { prettyJson?: boolean; nullText?: string } = {}): DetailValue {
  const pretty = options.prettyJson ?? true;
  if (value === null) return { kind: "null", label: "null", text: options.nullText ?? "null", copyText: "null" };

  switch (type) {
    case "bool":
      return { kind: "boolean", label: "boolean", text: value, copyText: value };
    case "number":
      return { kind: "number", label: "number", text: value, copyText: value };
    case "json": {
      const formatted = prettyJson(value);
      return { kind: "json", label: "json", text: pretty ? (formatted ?? value) : value, copyText: formatted ?? value };
    }
    case "array": {
      const parsed = parsePgArray(value);
      if (parsed) {
        return { kind: "json", label: "array", text: JSON.stringify(parsed, null, pretty ? 2 : undefined), copyText: value };
      }
      return { kind: "string", label: "array", text: value, copyText: value };
    }
    default:
      return { kind: "string", label: type || "string", text: value, copyText: value };
  }
}
