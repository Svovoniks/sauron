import { parsePgArray } from "../lib/pgArray";
import type { Cell } from "../types/app";

/** What the table / detail view shows for a cell. NULL is shown as the word "null". */
export const cellText = (value: Cell): string => (value === null ? "null" : value);

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
export function detailValue(type: string, value: Cell): DetailValue {
  if (value === null) return { kind: "null", label: "null", text: "null", copyText: "null" };

  switch (type) {
    case "bool":
      return { kind: "boolean", label: "boolean", text: value, copyText: value };
    case "number":
      return { kind: "number", label: "number", text: value, copyText: value };
    case "json": {
      const pretty = prettyJson(value);
      return { kind: "json", label: "json", text: pretty ?? value, copyText: pretty ?? value };
    }
    case "array": {
      const parsed = parsePgArray(value);
      if (parsed) {
        const pretty = JSON.stringify(parsed, null, 2);
        return { kind: "json", label: "array", text: pretty, copyText: value };
      }
      return { kind: "string", label: "array", text: value, copyText: value };
    }
    default:
      return { kind: "string", label: type || "string", text: value, copyText: value };
  }
}
