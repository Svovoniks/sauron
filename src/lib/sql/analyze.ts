import type { DbType } from "../../types/app";
import type { StatementRange } from "./splitStatements";

/** Lower-cased first word of a statement, skipping whitespace, comments and opening parens. */
export function firstKeyword(statement: string): string {
  let i = 0;
  const n = statement.length;
  while (i < n) {
    const c = statement[i];
    if (/\s/.test(c) || c === "(") {
      i++;
    } else if (c === "-" && statement[i + 1] === "-") {
      while (i < n && statement[i] !== "\n") i++;
    } else if (c === "/" && statement[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (statement[i] === "/" && statement[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (statement[i] === "*" && statement[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
    } else break;
  }
  const match = /^[A-Za-z]+/.exec(statement.slice(i));
  return match ? match[0].toLowerCase() : "";
}

const WRITE_KEYWORDS = new Set([
  "insert", "update", "delete", "drop", "alter", "truncate", "create", "grant", "revoke", "merge", "vacuum",
  "reindex", "cluster", "refresh", "comment", "call", "do", "rename", "optimize", "attach", "detach", "exchange",
  "kill", "system", "reassign", "security", "import",
]);

/** Text without string literals, quoted identifiers and comments, for keyword scanning. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "$$$$");
}

/** Does the statement change data or structure? Used by the production guard; errs on the side of asking. */
export function isWriteStatement(statement: string, _dialect: DbType): boolean {
  const keyword = firstKeyword(statement);
  if (keyword === "set" || keyword === "reset") {
    // Switching the connection's read-only mode off is how a script gets past "read-only".
    return /read_only|read\s+write|readonly/i.test(stripLiterals(statement));
  }
  if (keyword === "lock" || keyword === "execute") return true;
  if (keyword === "copy") return /\bprogram\b/i.test(stripLiterals(statement)) || !/\bto\b/i.test(stripLiterals(statement)) || /\bfrom\b/i.test(stripLiterals(statement));
  if (keyword === "explain") {
    // EXPLAIN ANALYZE really runs the statement it explains.
    return /\banalyze\b/i.test(stripLiterals(statement)) && /\b(insert|update|delete|merge)\b/i.test(stripLiterals(statement));
  }
  if (WRITE_KEYWORDS.has(keyword)) return true;
  if (keyword === "with" || keyword === "select") {
    const text = stripLiterals(statement);
    // data-modifying CTE, or SELECT ... INTO new_table
    return /\b(insert|update|delete|merge)\b/i.test(text) || (keyword === "select" && /\binto\s+(?!strict)[A-Za-z_"]/i.test(text) && !/\binsert\b/i.test(text) && /\bselect\b[\s\S]*\binto\b/i.test(text));
  }
  return false;
}

/** Backslash commands that run programs, read or write files on this computer. */
export function isRiskyMetaCommand(text: string): boolean {
  return text.split("\n").some((line) => /^\s*\\(!|copy\b|i\b|ir\b|include|o\b|out\b|w\b|cd\b|e\b|ef\b|ev\b|s\b|setenv\b|g\s*\||g\s+\S|gx\s+\S|gexec|lo_import|lo_export)/i.test(line));
}

/** The statement the cursor is in (or just after); falls back to the nearest one. */
export function statementAt(ranges: StatementRange[], offset: number): number {
  if (ranges.length === 0) return -1;
  let best = 0;
  let bestDistance = Infinity;
  ranges.forEach((range, index) => {
    // `end + 1` so a cursor right after the semicolon still belongs to that statement
    if (offset >= range.start && offset <= range.end + 1) {
      best = index;
      bestDistance = -1;
    } else if (bestDistance >= 0) {
      const distance = offset < range.start ? range.start - offset : offset - range.end;
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    }
  });
  return best;
}

/** Short label for a result set tab: "select", "update", "psql", ... */
export function statementLabel(sql: string): string {
  if (sql.trimStart().startsWith("\\")) return "psql";
  return firstKeyword(sql) || "sql";
}

/** "3 hours ago", "yesterday", ... relative to `now`. */
export function relativeTime(then: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks} weeks ago`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months} months ago`;
  return `${Math.round(days / 365)} years ago`;
}
