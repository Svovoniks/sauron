import type { DbType } from "../../types/app";

const isWhitespace = (c: string) => /\s/.test(c);

/** Characters that can be part of an unquoted identifier (non-ASCII letters included). */
const isIdentChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(c);
const isTagStart = (c: string | undefined) => c !== undefined && /[A-Za-z_\u0080-\uFFFF]/.test(c);
const isTagChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_\u0080-\uFFFF]/.test(c);

/**
 * Splits a SQL script into statements on top-level `;`.
 *
 * Semicolons inside strings, quoted identifiers, comments and (Postgres) dollar-quoted strings do not split.
 * Comments are kept in the statement they belong to; chunks consisting only of whitespace/comments are dropped.
 * Unterminated constructs swallow the rest of the input. Never throws.
 */
export function splitSqlStatements(sql: string, dialect: DbType): string[] {
  const pg = dialect === "postgres";
  const ch = dialect === "clickhouse";
  const statements: string[] = [];
  const n = sql.length;

  let start = 0;
  let hasContent = false;
  let i = 0;

  const flush = (end: number) => {
    if (hasContent) {
      const text = sql.slice(start, end).trim();
      if (text !== "") statements.push(text);
    }
    hasContent = false;
    start = end + 1;
  };

  /** Returns the index just past the closing quote (or n when unterminated). */
  const skipQuoted = (from: number, quote: string, backslash: boolean): number => {
    let j = from;
    while (j < n) {
      const c = sql[j];
      if (backslash && c === "\\") {
        j += 2;
      } else if (c === quote) {
        if (sql[j + 1] === quote) j += 2;
        else return j + 1;
      } else {
        j++;
      }
    }
    return n;
  };

  const skipLine = (from: number): number => {
    let j = from;
    while (j < n && sql[j] !== "\n") j++;
    return j;
  };

  const skipBlock = (from: number): number => {
    // `from` points just past the opening slash-star.
    let depth = 1;
    let j = from;
    while (j < n) {
      if (sql[j] === "*" && sql[j + 1] === "/") {
        j += 2;
        depth--;
        if (depth === 0) return j;
      } else if (pg && sql[j] === "/" && sql[j + 1] === "*") {
        j += 2;
        depth++;
      } else {
        j++;
      }
    }
    return n;
  };

  /** If a dollar-quote opener starts at `from`, returns its full tag including the `$`s. */
  const dollarTag = (from: number): string | null => {
    if (isIdentChar(sql[from - 1])) return null;
    let j = from + 1;
    if (sql[j] === "$") return "$$";
    if (!isTagStart(sql[j])) return null;
    while (isTagChar(sql[j])) j++;
    return sql[j] === "$" ? sql.slice(from, j + 1) : null;
  };

  while (i < n) {
    const c = sql[i];

    if (c === ";") {
      flush(i);
      i++;
    } else if (c === "'") {
      hasContent = true;
      let backslash = ch;
      if (pg) {
        const prev = sql[i - 1];
        backslash = (prev === "e" || prev === "E") && !isIdentChar(sql[i - 2]);
      }
      i = skipQuoted(i + 1, "'", backslash);
    } else if (c === '"') {
      hasContent = true;
      i = skipQuoted(i + 1, '"', ch);
    } else if (c === "`") {
      hasContent = true;
      i = skipQuoted(i + 1, "`", ch);
    } else if (c === "-" && sql[i + 1] === "-") {
      i = skipLine(i + 2);
    } else if (ch && c === "#") {
      i = skipLine(i + 1);
    } else if (c === "/" && sql[i + 1] === "*") {
      i = skipBlock(i + 2);
    } else if (pg && c === "$") {
      hasContent = true;
      const tag = dollarTag(i);
      if (tag === null) {
        i++;
      } else {
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? n : close + tag.length;
      }
    } else {
      if (!isWhitespace(c)) hasContent = true;
      i++;
    }
  }

  flush(n);
  return statements;
}
