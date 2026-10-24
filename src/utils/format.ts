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

const prettyJson = (text: string): string | null => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
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
