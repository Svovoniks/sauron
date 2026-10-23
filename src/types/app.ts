export type DbType = "postgres" | "clickhouse";

/**
 * disable: no TLS (ClickHouse: http)
 * prefer:  Postgres only - try TLS, fall back to plaintext
 * require: TLS without certificate verification (ClickHouse: https, no verification)
 * verify:  TLS with full certificate + hostname verification
 */
export type SslMode = "disable" | "prefer" | "require" | "verify";

/** What a connection is used for; "prod" turns on the production guard and the red markers. */
export type Env = "" | "local" | "staging" | "prod";
export const ENVS: readonly Env[] = ["", "local", "staging", "prod"];
export const ENV_LABEL: Record<Env, string> = { "": "none", local: "local", staging: "staging", prod: "prod" };

/** Persisted connection. The password is NOT part of it - it lives in the OS keychain, keyed by `id`. */
export interface Connection {
  id: string;
  name: string;
  host: string;
  port: string;
  username: string;
  database: string;
  db_type: DbType;
  ssl_mode: SslMode;
  read_only: boolean;
  /** Per-statement timeout in seconds, 0 = no timeout. */
  timeout_secs: number;
  env: Env;
}

/** Connection being edited in the modal: `password === ""` on an existing connection means "unchanged". */
export type ConnectionDraft = Connection & { password: string };

/**
 * `type` is the UI type chosen by the backend:
 * "bool" | "number" | "json" | "array" | "timestamp" | "timestamp tz" | "string"
 */
export interface ColumnMeta {
  name: string;
  type: string;
}

/** A cell is the exact text the database returned, or null for SQL NULL. */
export type Cell = string | null;

/** Why one statement failed; `position` is the 1-based character offset inside that statement. */
export interface StatementError {
  message: string;
  code: string | null;
  position: number | null;
}

/** What one statement of a script produced (see `execute_script` in lib.rs). */
export interface StatementOutcome {
  sql: string;
  elapsed_ms: number;
  result: QueryResult | null;
  error: StatementError | null;
}

export interface TestStep {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

export interface TestReport {
  ok: boolean;
  steps: TestStep[];
  server_version: string | null;
}

export interface QueryResult {
  columns: ColumnMeta[];
  rows: Cell[][];
  /** True when the row limit cut the result short. */
  truncated: boolean;
  /** Set for statements that return no rows, e.g. "3 rows affected". */
  message: string | null;
}

/** What a backslash command (`\dt`, `\d table`, ...) prints: text laid out exactly like psql. */
export interface MetaResult {
  text: string;
}

export interface SavedQuery {
  id: string;
  name: string;
  query: string;
}

export interface SavedResult {
  id: string;
  name: string;
  query: string;
  columns: ColumnMeta[];
  rows: Cell[][];
  truncated: boolean;
}

/** Key used in `queries` / `results` for items shared between all connections. */
export const GLOBAL_SCOPE = "global";

export interface AppData {
  connections: Connection[];
  activeConnectionId: string | null;
  /** scope (connection id or GLOBAL_SCOPE) -> items */
  queries: Record<string, SavedQuery[]>;
  results: Record<string, SavedResult[]>;
}

export const emptyAppData = (): AppData => ({
  connections: [],
  activeConnectionId: null,
  queries: {},
  results: {},
});

export const defaultPort = (dbType: DbType) => (dbType === "postgres" ? "5432" : "8123");

/** Defaults for a new connection (Settings → Connections). */
export interface DraftDefaults {
  readOnly: boolean;
  timeoutSecs: number;
  sslMode: SslMode;
}

export const emptyDraft = (defaults: Partial<DraftDefaults> = {}): ConnectionDraft => ({
  id: "",
  name: "",
  host: "",
  port: defaultPort("postgres"),
  username: "",
  database: "",
  db_type: "postgres",
  ssl_mode: defaults.sslMode ?? "require",
  read_only: defaults.readOnly ?? true,
  timeout_secs: defaults.timeoutSecs ?? 60,
  env: "",
  password: "",
});

export interface Notice {
  id: number;
  kind: "info" | "error";
  text: string;
}
