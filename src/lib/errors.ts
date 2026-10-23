import { closestName, parseMissingIdentifier, type Schema } from "./schema";
import type { StatementError } from "../types/app";

/** Presentation helpers for a failed statement. */

export interface ErrorSnippet {
  /** 1-based line inside the statement and the line's text. */
  line: number;
  text: string;
  /** 0-based column of the problem inside `text`, and how many characters to underline. */
  column: number;
  length: number;
}

/** Where `position` (1-based character offset into `sql`) points, or null when unknown / out of range. */
export function errorSnippet(sql: string, position: number | null): ErrorSnippet | null {
  if (position === null || position < 1 || position > sql.length) return null;
  const index = position - 1;
  const before = sql.slice(0, index);
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineEnd = sql.indexOf("\n", index);
  const text = sql.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const token = /^[\w$."`]+/.exec(sql.slice(index));
  return { line, text, column: index - lineStart, length: Math.max(1, token ? token[0].length : 1) };
}

/** Length of the identifier-like token starting at `position`, for the editor squiggle. */
export function tokenLengthAt(sql: string, position: number): number {
  const token = /^[\w$."`]+/.exec(sql.slice(Math.max(0, position - 1)));
  return Math.max(1, token ? token[0].length : 1);
}

export interface ErrorView {
  kind: "timeout" | "connection" | "cancelled" | "readonly" | "error";
  title: string;
  /** Everything after the first line (DETAIL, HINT, ...). */
  detail: string;
  code: string | null;
}

const PG_PREFIX = /^(ERROR|FATAL|PANIC):\s*/;

export function describeError(error: StatementError | { message: string; code?: null }, timeoutSecs: number): ErrorView {
  const message = error.message;
  const code = "code" in error ? (error.code ?? null) : null;
  const [first, ...rest] = message.split("\n");
  const headline = first.replace(PG_PREFIX, "");
  const detail = rest.join("\n").trim();

  if (code === "57014" && /statement timeout/i.test(message)) {
    return { kind: "timeout", title: timeoutSecs > 0 ? `Query stopped after ${timeoutSecs} seconds` : "Query stopped by the server's timeout", detail: "The connection's timeout cancelled this statement on the server.", code };
  }
  if (/^CH 159$/.test(code ?? "") || /Timeout exceeded|TIMEOUT_EXCEEDED|Request timed out/i.test(message)) {
    return { kind: "timeout", title: timeoutSecs > 0 ? `Query stopped after ${timeoutSecs} seconds` : "Query timed out", detail: "The query took longer than the connection's timeout.", code };
  }
  if (message === "Query was cancelled" || message === "Query was aborted.") {
    return { kind: "cancelled", title: "Cancelled", detail: "The query was stopped before it finished. Statements of a script that had already finished are not rolled back.", code };
  }
  if (code === "25006" || /read-only transaction|readonly mode/i.test(message)) {
    return { kind: "readonly", title: headline, detail, code };
  }
  return { kind: "error", title: headline, detail, code };
}

export interface QuickFix {
  /** What the button says: Replace “create_at” with “created_at”. */
  label: string;
  from: string;
  to: string;
}

/** "Did you mean …?" for a misspelled column or table name, from the loaded schema. */
export function quickFix(message: string, schema: Schema | null): QuickFix | null {
  if (!schema) return null;
  const missing = parseMissingIdentifier(message);
  if (!missing) return null;
  const pool = missing.kind === "table" ? schema.tables.map((t) => t.name) : schema.tables.flatMap((t) => t.columns.map((c) => c.name));
  const match = closestName(missing.name, pool);
  return match ? { label: `Replace ${missing.name} with ${match}`, from: missing.name, to: match } : null;
}

/** First whole-word occurrence of `word` in `sql` outside of string literals, or -1. */
export function findIdentifier(sql: string, word: string, near?: number): number {
  const re = new RegExp(`(?<![\\w$])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`, "g");
  const hits: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) hits.push(m.index);
  if (hits.length === 0) return -1;
  if (near === undefined) return hits[0];
  return hits.reduce((best, hit) => (Math.abs(hit - near) < Math.abs(best - near) ? hit : best), hits[0]);
}
