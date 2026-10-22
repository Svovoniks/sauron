import { mockIPC } from "@tauri-apps/api/mocks";
import type { QueryResult } from "../types/app";

/**
 * Development only (see main.tsx): fake backend so the UI can be exercised in a plain browser
 * with `bun run dev`. Never part of the production bundle.
 *
 * Magic SQL: "sleep" waits 10s (cancellable), "boom" fails, "ddl" returns a message,
 * "empty" returns a result with columns but no rows, anything else returns sample rows.
 */

const files = new Map<string, string>();
const passwords = new Map<string, string>();
let cancelled = false;

const sampleResult = (rowLimit: number): QueryResult => {
  const total = 12_000;
  const count = Math.min(total, rowLimit);
  const rows = Array.from({ length: count }, (_, i) => [
    String(9007199254740993n + BigInt(i)),
    String(i + 1),
    i % 7 === 0 ? null : `name ${i} — a fairly long value to see truncation in the table cell`,
    i % 2 === 0 ? "true" : "false",
    `{${i},"b c",NULL}`,
    JSON.stringify({ index: i, nested: { ok: true, big: "18446744073709551615" } }),
    `2026-01-${String((i % 28) + 1).padStart(2, "0")} 12:00:00+00`,
    i === 3 ? "<<null>>" : "1.50",
  ]);
  return {
    columns: [
      { name: "id", type: "number" },
      { name: "id", type: "number" },
      { name: "name", type: "string" },
      { name: "active", type: "bool" },
      { name: "tags", type: "array" },
      { name: "meta", type: "json" },
      { name: "created_at", type: "timestamp tz" },
      { name: "price", type: "string" },
    ],
    rows,
    truncated: total > count,
    message: null,
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function installDevMock() {
  mockIPC(async (cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "storage_read":
        return files.get(args.name as string) ?? null;
      case "storage_write":
        files.set(args.name as string, args.content as string);
        return null;
      case "storage_quarantine":
        files.delete(args.name as string);
        return "/mock/quarantine";
      case "plugin:dialog|open":
        return "/mock/schema.sql";
      case "plugin:fs|read_text_file":
        return new TextEncoder().encode("-- demo script\nCREATE TEMP TABLE t AS SELECT 1 AS a;\nSELECT * FROM t;\n").buffer;
      case "has_password":
        return passwords.has(args.connectionId as string);
      case "get_password":
        return passwords.get(args.connectionId as string) ?? null;
      case "save_password":
        passwords.set(args.connectionId as string, args.password as string);
        return null;
      case "delete_password":
        passwords.delete(args.connectionId as string);
        return null;
      case "cancel_query":
        cancelled = true;
        return null;
      case "execute_meta_command": {
        const text = String(args.commandText);
        if (text.startsWith("\\d ")) {
          return {
            text: [
              '                Table "public.users"',
              " Column |  Type  | Collation | Nullable |           Default",
              "--------+--------+-----------+----------+------------------------------",
              " id     | bigint |           | not null | generated always as identity",
              " email  | text   |           |          |",
              "Indexes:",
              '    "users_pkey" PRIMARY KEY, btree (id)',
              "",
            ].join("\n"),
          };
        }
        return {
          text: [
            "       List of relations",
            " Schema |  Name  | Type  | Owner",
            "--------+--------+-------+-------",
            " public | users  | table | app",
            " public | orders | table | app",
            "(2 rows)",
            "",
          ].join("\n"),
        };
      }
      case "execute_query": {
        cancelled = false;
        const statements = args.statements as string[];
        const sql = statements.join(";\n");
        if (sql.includes("sleep")) {
          for (let i = 0; i < 100 && !cancelled; i++) await sleep(100);
          if (cancelled) throw "Query was cancelled";
        }
        await sleep(150);
        if (sql.includes("boom")) throw 'ERROR: relation "boom" does not exist';
        if (sql.includes("ddl")) return { columns: [], rows: [], truncated: false, message: "3 rows affected" };
        if (sql.includes("empty")) {
          return { columns: [{ name: "a", type: "number" }, { name: "b", type: "string" }], rows: [], truncated: false, message: null };
        }
        return sampleResult(args.rowLimit as number);
      }
      default:
        return null;
    }
  });
}
