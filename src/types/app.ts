export type DbType = "postgres" | "clickhouse";

/**
 * disable: no TLS (ClickHouse: http)
 * prefer:  Postgres only - try TLS, fall back to plaintext
 * require: TLS without certificate verification (ClickHouse: https, no verification)
 * verify:  TLS with full certificate + hostname verification
 */
export type SslMode = "disable" | "prefer" | "require" | "verify";

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

export const emptyDraft = (): ConnectionDraft => ({
  id: "",
  name: "",
  host: "",
  port: defaultPort("postgres"),
  username: "",
  database: "",
  db_type: "postgres",
  ssl_mode: "require",
  read_only: true,
  timeout_secs: 60,
  password: "",
});

export interface Notice {
  id: number;
  kind: "info" | "error";
  text: string;
}
