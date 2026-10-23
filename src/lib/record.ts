import { parsePgArray } from "./pgArray";
import type { Cell, ColumnMeta } from "../types/app";

/** Turns a result row into things to copy / compare. Values stay exact: nothing is rounded or reinterpreted. */

const SAFE_INT = /^-?(0|[1-9]\d{0,14})$/;

/** The cell as a typed JSON value: bool -> boolean, safe integers -> number, json / arrays parsed, the rest strings. */
export function typedValue(column: ColumnMeta, cell: Cell): unknown {
  if (cell === null) return null;
  switch (column.type) {
    case "bool":
      return cell === "true" ? true : cell === "false" ? false : cell;
    case "number":
      // Large / fractional numbers stay text so no digit is lost.
      return SAFE_INT.test(cell) ? Number(cell) : cell;
    case "json":
      try {
        return JSON.parse(cell) as unknown;
      } catch {
        return cell;
      }
    case "array":
      return parsePgArray(cell) ?? cell;
    default:
      return cell;
  }
}

export function rowToObject(columns: ColumnMeta[], row: Cell[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  columns.forEach((column, i) => {
    let name = column.name || `column${i + 1}`;
    for (let n = 2; name in out; n++) name = `${column.name}_${n}`; // duplicate column names must not overwrite each other
    out[name] = typedValue(column, row[i] ?? null);
  });
  return out;
}

const quoteLiteral = (value: string, dialect: "postgres" | "clickhouse") =>
  `'${(dialect === "clickhouse" ? value.replace(/\\/g, "\\\\") : value).replace(/'/g, dialect === "clickhouse" ? "\\'" : "''")}'`;
const quoteName = (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

export function rowToInsert(table: string, columns: ColumnMeta[], row: Cell[], dialect: "postgres" | "clickhouse" = "postgres"): string {
  const names = columns.map((c) => quoteName(c.name)).join(", ");
  const values = columns
    .map((column, i) => {
      const cell = row[i] ?? null;
      if (cell === null) return "NULL";
      if (column.type === "number" && /^-?\d+(\.\d+)?$/.test(cell)) return cell;
      if (column.type === "bool" && (cell === "true" || cell === "false")) return cell.toUpperCase();
      return quoteLiteral(cell, dialect);
    })
    .join(", ");
  return `insert into ${table} (${names}) values (${values});`;
}

/** "2026-09-02 09:14:22+00" -> epoch ms, or null if it does not look like a timestamp. */
export function parseTimestamp(text: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(text.trim());
  if (!m) return null;
  let zone = m[3] ?? "Z";
  if (/^[+-]\d{2}$/.test(zone)) zone += ":00";
  else if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const t = Date.parse(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(t) ? null : t;
}

const MAX_SNIFF_CHARS = 2_000_000;

/**
 * A text value that holds a JSON object or array (an API response in a text column, say), parsed for display.
 * Only ever used to *show* it nicely: the original text is what gets copied.
 */
export function embeddedJson(value: string): object | null {
  if (value.length > MAX_SNIFF_CHARS) return null;
  const first = value.trimStart()[0];
  if (first !== "{" && first !== "[") return null;
  if (sniffCache.has(value)) return sniffCache.get(value) ?? null;
  let result: object | null = null;
  try {
    const parsed: unknown = JSON.parse(value);
    result = typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    result = null;
  }
  // The inspector asks about the same value a few times per render; keep the last few answers.
  if (sniffCache.size >= 8) sniffCache.delete(sniffCache.keys().next().value as string);
  sniffCache.set(value, result);
  return result;
}

const sniffCache = new Map<string, object | null>();
