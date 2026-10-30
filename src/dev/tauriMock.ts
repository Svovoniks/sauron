import { mockIPC } from "@tauri-apps/api/mocks";
import type { QueryResult, StatementOutcome } from "../types/app";

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

const rowsResult = (names: string[], rows: (string | null)[][]): QueryResult => ({
  columns: names.map((name) => ({ name, type: "string" })),
  rows,
  truncated: false,
  message: null,
});

// `?tables=2000` in the dev URL adds that many fake tables (to see how big schemas behave).
const EXTRA_TABLES = Number(new URLSearchParams(globalThis.location?.search ?? "").get("tables")) || 0;

const TABLES: [string, string, string, string][] = [
  ["customers", "r", "14", "49152"],
  ["orders", "r", "1200000", "327155712"],
  ["order_items", "r", "4800000", "1181116006"],
  ["products", "r", "3410", "2097152"],
  ["invoices", "p", "88000", "22020096"],
  ["refunds", "r", "2904", "655360"],
  ...Array.from({ length: EXTRA_TABLES }, (_, i): [string, string, string, string] => [`bulk_table_${i}`, "r", String(i * 7), String(i * 8192)]),
];
const COLUMNS: Record<string, [string, string, string][]> = {
  customers: [["id", "bigint", "false"], ["name", "text", "true"], ["email", "text", "true"], ["plan", "text", "true"], ["seats", "integer", "true"], ["active", "boolean", "false"], ["created_at", "timestamp with time zone", "false"]],
  orders: [["id", "bigint", "false"], ["customer_id", "bigint", "false"], ["status", "order_status", "false"], ["total", "numeric(12,2)", "false"], ["created_at", "timestamp with time zone", "false"]],
  order_items: [["id", "bigint", "false"], ["order_id", "bigint", "false"], ["product_id", "bigint", "false"], ["qty", "integer", "false"], ["price", "numeric(12,2)", "false"]],
  products: [["id", "bigint", "false"], ["sku", "text", "false"], ["title", "text", "false"], ["price", "numeric(12,2)", "false"]],
  invoices: [["id", "bigint", "false"], ["customer_id", "bigint", "false"], ["due_date", "date", "true"], ["status", "text", "false"]],
  refunds: [["id", "bigint", "false"], ["order_id", "bigint", "false"], ["amount", "numeric(12,2)", "false"], ["reason", "text", "true"]],
};

/** Catalog queries of the schema explorer (see lib/schema.ts) are answered from the tables above. */
function catalogResult(sql: string): QueryResult | null {
  if (/from pg_class c join pg_namespace n on n\.oid = c\.relnamespace where c\.relkind/.test(sql)) {
    return rowsResult(["nspname", "relname", "relkind", "reltuples", "size"], [...TABLES.map(([n, k, r, b]): (string | null)[] => ["public", n, k, r, b]), ["public", "active_customers", "v", "-1", null]]);
  }
  if (sql.includes("from pg_attribute a")) {
    const rows = Object.entries(COLUMNS).flatMap(([table, cols]) => cols.map(([c, t, nullable]) => ["public", table, c, t, nullable]));
    return rowsResult(["nspname", "relname", "attname", "type", "nullable"], rows);
  }
  if (sql.includes("from pg_constraint")) {
    return rowsResult(["nspname", "relname", "attname", "contype"], [["public", "customers", "id", "p"], ["public", "orders", "id", "p"], ["public", "orders", "customer_id", "f"], ["public", "order_items", "order_id", "f"]]);
  }
  if (sql.includes("from pg_proc p")) {
    return rowsResult(["nspname", "proname", "args", "result"], [["public", "customer_ltv", "customer_id bigint", "numeric"], ["public", "refresh_rollups", "", "void"]]);
  }
  return null;
}

/** A few calls an agent made, so the Agent tab has something to show (cleared with its "Clear" button). */
let agentLog = (() => {
  const now = Date.now();
  const at = (minutesAgo: number) => now - minutesAgo * 60_000;
  const id = (t: number) => `${String(t).padStart(15, "0")}-mock`;
  const entry = (minutesAgo: number, patch: Record<string, unknown>) => ({
    id: id(at(minutesAgo)), at: at(minutesAgo), client: "claude-code", tool: "query", connection_id: "local", connection_name: "local",
    sql: "", ms: 42, status: "ok", output: "", rows: null, truncated: false, ...patch,
  });
  return [
    entry(0.2, { sql: "select status, count(*), sum(total)\nfrom orders\ngroup by 1\norder by 2 desc", rows: 5, ms: 18 }),
    entry(0.6, { status: "blocked", sql: "delete from orders where status = 'cancelled'", output: "\"local\" is read-only for agents, so only reading statements (SELECT, WITH, SHOW, EXPLAIN, ...) are allowed. Start the MCP server with --allow-writes to allow writes on connections that are not read-only or prod." }),
    entry(1, { status: "error", sql: "select totl from orders", output: "Error: ERROR: column \"totl\" does not exist\nHINT: Perhaps you meant to reference the column \"orders.total\".\nCode: 42703\nPosition: 8", ms: 6 }),
    entry(1.4, { tool: "describe_table", sql: "\\d+ orders", output: "                 Table \"public.orders\"\n   Column    |  Type   | Nullable \n-------------+---------+----------\n id          | integer | not null \n customer_id | integer |          \n status      | text    |          \n total       | numeric |          \nIndexes:\n    \"orders_pkey\" PRIMARY KEY, btree (id)" }),
    entry(1.5, { tool: "list_tables", sql: "\\dtvm+", output: "List of relations\n Schema |   Name    | Type  \n--------+-----------+-------\n public | customers | table\n public | orders    | table" }),
    entry(1.6, { tool: "list_connections", connection_name: "", output: "[{ \"name\": \"local\", \"type\": \"postgres\", \"read_only\": true }]", ms: 1 }),
  ];
})();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A few connections and saved queries so the UI is not empty (add ?empty to the URL for the first-run screen). */
function seed() {
  const conn = (id: string, name: string, host: string, env: string, read_only: boolean, db_type = "postgres") => ({
    id, name, host, port: db_type === "postgres" ? "5432" : "8123", username: "dev", database: "shop_dev", db_type, ssl_mode: "require", read_only, timeout_secs: 60, env, description: "", ssl_root_cert: "", ssl_cert: "", ssl_key: "", use_default_certs: false,
  });
  files.set(
    "connections",
    JSON.stringify({
      version: 2,
      activeConnectionId: "local",
      connections: [
        conn("local", "local", "127.0.0.1", "local", false),
        conn("staging", "staging", "pg.staging.internal", "staging", true),
        conn("prod", "prod-replica", "pg-replica.prod.internal", "prod", false),
        conn("events", "events", "ch.prod.internal", "prod", true, "clickhouse"),
      ],
    }),
  );
  files.set(
    "queries",
    JSON.stringify({
      version: 2,
      byScope: {
        local: [
          { id: "q1", name: "active paying customers", query: "select id, name, email, plan, seats\nfrom customers\nwhere active and plan <> 'free'\norder by seats desc;" },
          { id: "q2", name: "orders by status", query: "select status, count(*), sum(total)\nfrom orders\ngroup by 1\norder by 2 desc;" },
        ],
      },
    }),
  );
  passwords.set("local", "dev");
}

const params = new URLSearchParams(location.search);

async function runScript(steps: string[]) {
  await sleep(1800);
  for (const step of steps) {
    const sep = step.indexOf(":");
    const kind = step.slice(0, sep);
    const arg = step.slice(sep + 1);
    if (kind === "click" || kind === "rclick") {
      const el = document.querySelector<HTMLElement>(arg);
      if (el) el.dispatchEvent(new MouseEvent(kind === "rclick" ? "contextmenu" : "click", { bubbles: true, cancelable: true, button: kind === "rclick" ? 2 : 0 }));
    } else if (kind === "key") {
      const parts = arg.split("+");
      const key = parts[parts.length - 1];
      const mods = parts.slice(0, -1);
      window.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: mods.includes("Mod"), shiftKey: mods.includes("Shift"), altKey: mods.includes("Alt"), bubbles: true }));
    } else if (kind === "css") {
      const style = document.createElement("style");
      style.textContent = arg;
      document.head.appendChild(style);
    } else if (kind === "type") {
      const [selector, text] = arg.split("=");
      const el = document.querySelector<HTMLInputElement>(selector);
      if (el) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else if (kind === "wait") await sleep(Number(arg));
    await sleep(700);
  }
}

export function installDevMock() {
  if (!params.has("empty")) seed();
  // ?settings={"theme":"forest"} pre-seeds settings.json, handy for looking at one theme without clicking through Settings.
  const settings = params.get("settings");
  if (settings) files.set("settings", settings);
  // ?autorun presses Mod+Enter once the UI is up so a screenshot has a result table in it.
  // ?script=click:.sel|key:Mod+k|wait:500|type:.sel=abc replays UI steps (one per 700 ms) so a screenshot can show any state.
  const script = params.get("script");
  if (script) void runScript(script.split("|"));
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
      case "check_for_update":
        await sleep(600);
        // add ?update to the URL to see the update dialog in the browser
        return new URLSearchParams(location.search).has("update")
          ? { version: "9.9.9", current_version: "0.3.1", notes: "## What's new\n- Settings, query tabs, schema explorer\n- Auto update", date: "2026-10-23 10:00:00.0 +00:00:00" }
          : null;
      case "install_update":
        await sleep(1500);
        return null;
      case "restart_app":
        return null;
      case "agent_log_list":
        return agentLog;
      case "agent_log_latest":
        return agentLog[0]?.id ?? null;
      case "agent_log_result":
        return agentLog.find((e) => e.id === args.id)?.rows ? rowsResult(["status", "count", "sum"], [["paid", "412", "48210.50"], ["shipped", "380", "40211.00"], ["new", "97", "10022.10"], ["cancelled", "31", "2901.75"], ["refunded", "9", null]]) : null;
      case "agent_log_clear":
        agentLog = [];
        return null;
      case "storage_dir":
        return "/Users/demo/Library/Application Support/com.svovoniks.sauron";
      case "mcp_executable":
        return "/Applications/sauron.app/Contents/MacOS/sauron";
      case "test_connection": {
        const connection = args.connection as { host: string };
        await sleep(400);
        if (/^bad/.test(connection.host)) {
          return { ok: false, server_version: null, steps: [{ name: "Resolve host", ok: false, detail: "no such host (failed to lookup address)", ms: 12 }] };
        }
        return {
          ok: true,
          server_version: "PostgreSQL 16.4",
          steps: [
            { name: "Resolve host", ok: true, detail: "127.0.0.1", ms: 2 },
            { name: "Open TCP connection", ok: true, detail: "port 5432", ms: 3 },
            { name: "Encrypt and log in", ok: true, detail: "TLS, certificate not checked", ms: 41 },
            { name: "Server version", ok: true, detail: "PostgreSQL 16.4", ms: 2 },
            { name: "Read-only mode", ok: true, detail: "on", ms: 0 },
          ],
        };
      }
      case "execute_script": {
        cancelled = false;
        const statements = args.statements as string[];
        const rowLimit = args.rowLimit as number;
        const outcomes: StatementOutcome[] = [];
        for (const sql of statements) {
          const started = Date.now();
          const catalog = catalogResult(sql);
          if (catalog) {
            outcomes.push({ sql, elapsed_ms: 3, result: catalog, error: null });
            continue;
          }
          if (sql.includes("sleep") || params.has("slow")) {
            for (let i = 0; i < (params.has("slow") ? 1200 : 100) && !cancelled; i++) await sleep(100);
            if (cancelled) throw "Query was cancelled";
          }
          await sleep(120);
          const fail = (message: string, code: string, position: number | null) =>
            outcomes.push({ sql, elapsed_ms: Date.now() - started, result: null, error: { message, code, position } });
          if (sql.includes("create_at")) {
            fail('ERROR: column "create_at" does not exist\nHINT: Perhaps you meant to reference the column "customers.created_at".', "42703", sql.indexOf("create_at") + 1);
            break;
          }
          if (sql.includes("timeout")) {
            fail("ERROR: canceling statement due to statement timeout", "57014", null);
            break;
          }
          if (sql.includes("offline")) throw "error connecting to server: Connection refused (os error 61)";
          if (sql.includes("boom")) {
            fail('ERROR: relation "boom" does not exist', "42P01", sql.indexOf("boom") + 1);
            break;
          }
          if (sql.includes("response_body")) {
            outcomes.push({ sql, elapsed_ms: 5, error: null, result: rowsResult(["id", "response_body"], [["1", '{"event_response":{"event_id":"01a167c1","status":1,"time":{"seconds":1792742124},"simplified_status":1}}']]) });
            continue;
          }
          const write = /^\s*(update|insert|delete)/i.test(sql);
          const result = write || sql.includes("ddl")
            ? { columns: [], rows: [], truncated: false, message: write ? "3 rows affected" : "Statement executed" }
            : sql.includes("empty")
              ? { columns: [{ name: "a", type: "number" }, { name: "b", type: "string" }], rows: [], truncated: false, message: null }
              : sampleResult(rowLimit);
          outcomes.push({ sql, elapsed_ms: Date.now() - started, result, error: null });
        }
        return outcomes;
      }
      case "execute_query": {
        cancelled = false;
        const statements = args.statements as string[];
        const sql = statements.join(";\n");
        if (sql.includes("sleep") || params.has("slow")) {
          for (let i = 0; i < (params.has("slow") ? 1200 : 100) && !cancelled; i++) await sleep(100);
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
