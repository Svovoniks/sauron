import type { Cell, DbType, StatementOutcome } from "../types/app";

/** What the schema explorer and the editor's autocomplete know about a database. */

export type ObjectKind = "table" | "view" | "matview" | "foreign";
export type ColumnKey = "pk" | "fk" | "";

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  key: ColumnKey;
}

export interface SchemaTable {
  schema: string;
  name: string;
  kind: ObjectKind;
  /** Planner estimate, null when unknown. */
  rows: number | null;
  bytes: number | null;
  columns: SchemaColumn[];
}

export interface SchemaFunction {
  schema: string;
  name: string;
  args: string;
  returns: string;
}

export interface Schema {
  dbType: DbType;
  tables: SchemaTable[];
  functions: SchemaFunction[];
  schemas: string[];
  loadedAt: number;
}

const PG_SYSTEM = `('pg_catalog','information_schema','pg_toast')`;
const CH_SYSTEM = `('system','INFORMATION_SCHEMA','information_schema')`;

/**
 * Catalog queries, one statement each. The first one (the table list) is cheap and is loaded alone so the tree
 * can appear at once; the rest (columns, keys, functions) follow. Sizes are not read: on big databases
 * `pg_total_relation_size` for every table was the slowest part and the row estimate is enough to judge a table.
 */
export function schemaQueries(dbType: DbType): string[] {
  if (dbType === "clickhouse") {
    return [
      `select database, name, engine, total_rows, total_bytes from system.tables where database not in ${CH_SYSTEM} order by database, name`,
      `select database, table, name, type, is_in_primary_key from system.columns where database not in ${CH_SYSTEM} order by database, table, position`,
    ];
  }
  const kinds = `c.relkind in ('r','p','v','m','f') and n.nspname not in ${PG_SYSTEM} and n.nspname not like 'pg\\_temp%' and n.nspname not like 'pg\\_toast\\_temp%'`;
  return [
    `select n.nspname, c.relname, c.relkind::text, c.reltuples::bigint, null::bigint from pg_class c join pg_namespace n on n.oid = c.relnamespace where ${kinds} order by 1, 2`,
    `select n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod), not a.attnotnull from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace where a.attnum > 0 and not a.attisdropped and ${kinds} order by n.nspname, c.relname, a.attnum`,
    `select n.nspname, c.relname, a.attname, con.contype::text from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any(con.conkey) where con.contype in ('p','f') and n.nspname not in ${PG_SYSTEM}`,
    `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.prokind = 'f' and n.nspname not in ${PG_SYSTEM} order by 1, 2 limit 2000`,
  ];
}

const num = (cell: Cell | undefined): number | null => {
  if (cell === null || cell === undefined) return null;
  const n = Number(cell);
  return Number.isFinite(n) ? n : null;
};

const rowsOf = (outcome: StatementOutcome | undefined): Cell[][] => outcome?.result?.rows ?? [];

/** Turns the results of `schemaQueries` into a Schema. Missing / failed queries just leave their part empty. */
export function buildSchema(dbType: DbType, outcomes: StatementOutcome[], now = Date.now()): Schema {
  const byKey = new Map<string, SchemaTable>();
  const tables: SchemaTable[] = [];
  const keyOf = (schema: Cell | undefined, name: Cell | undefined) => `${schema}\u0000${name}`;

  if (dbType === "postgres") {
    const KIND: Record<string, ObjectKind> = { r: "table", p: "table", v: "view", m: "matview", f: "foreign" };
    for (const [schema, name, relkind, tuples, bytes] of rowsOf(outcomes[0])) {
      if (schema === null || name === null) continue;
      const rows = num(tuples);
      const table: SchemaTable = { schema, name, kind: KIND[relkind ?? ""] ?? "table", rows: rows !== null && rows >= 0 ? rows : null, bytes: num(bytes), columns: [] };
      tables.push(table);
      byKey.set(keyOf(schema, name), table);
    }
    for (const [schema, name, column, type, nullable] of rowsOf(outcomes[1])) {
      const table = byKey.get(keyOf(schema, name));
      if (table && column !== null) table.columns.push({ name: column, type: type ?? "", nullable: nullable === "true", key: "" });
    }
    for (const [schema, name, column, contype] of rowsOf(outcomes[2])) {
      const col = byKey.get(keyOf(schema, name))?.columns.find((c) => c.name === column);
      if (!col) continue;
      if (contype === "p") col.key = "pk";
      else if (col.key === "") col.key = "fk";
    }
  } else {
    for (const [schema, name, engine, totalRows, totalBytes] of rowsOf(outcomes[0])) {
      if (schema === null || name === null) continue;
      const kind: ObjectKind = /MaterializedView/i.test(engine ?? "") ? "matview" : /View/i.test(engine ?? "") ? "view" : "table";
      const table: SchemaTable = { schema, name, kind, rows: num(totalRows), bytes: num(totalBytes), columns: [] };
      tables.push(table);
      byKey.set(keyOf(schema, name), table);
    }
    for (const [schema, name, column, type, inPk] of rowsOf(outcomes[1])) {
      const table = byKey.get(keyOf(schema, name));
      if (table && column !== null) table.columns.push({ name: column, type: type ?? "", nullable: /^Nullable\(/.test(type ?? ""), key: inPk === "1" ? "pk" : "" });
    }
  }

  const functions: SchemaFunction[] = [];
  if (dbType === "postgres") {
    for (const [schema, name, args, returns] of rowsOf(outcomes[3])) {
      if (schema !== null && name !== null) functions.push({ schema, name, args: args ?? "", returns: returns ?? "" });
    }
  }

  const schemas = [...new Set(tables.map((t) => t.schema))].sort((a, b) => (a === "public" ? -1 : b === "public" ? 1 : a.localeCompare(b)));
  return { dbType, tables, functions, schemas, loadedAt: now };
}

/** First error among the outcomes of a schema load, if the core queries failed. */
export function schemaLoadError(outcomes: StatementOutcome[], needed: number): string | null {
  for (let i = 0; i < needed; i++) {
    const error = outcomes[i]?.error;
    if (error) return error.message;
    if (!outcomes[i]) return "The schema query did not run.";
  }
  return null;
}

// --- display helpers ----------------------------------------------------------------------------

export function formatCount(n: number | null): string {
  if (n === null) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString("en-US");
}

export function formatBytes(n: number | null): string {
  if (n === null) return "";
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GB`;
  if (n >= 2 ** 20) return `${Math.round(n / 2 ** 20)} MB`;
  if (n >= 2 ** 10) return `${Math.round(n / 2 ** 10)} kB`;
  return `${n} B`;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Quote an identifier only when it needs it. */
export function quoteIdent(name: string, dbType: DbType): string {
  if (IDENT.test(name) && !RESERVED.has(name)) return name;
  return dbType === "postgres" ? `"${name.replace(/"/g, '""')}"` : `\`${name.replace(/`/g, "\\`")}\``;
}

const RESERVED = new Set(["user", "order", "group", "table", "select", "from", "where", "limit", "offset", "end", "all", "analyse", "analyze", "and", "any", "as", "asc", "desc", "case", "check", "column", "constraint", "default", "distinct", "do", "else", "having", "in", "is", "join", "like", "not", "null", "on", "or", "primary", "references", "then", "to", "union", "unique", "using", "when", "with"]);

/** Name to put in SQL: schema-qualified unless it is the default schema (public / the connection's database). */
export function qualifiedName(table: Pick<SchemaTable, "schema" | "name">, dbType: DbType, defaultSchema: string): string {
  const name = quoteIdent(table.name, dbType);
  return table.schema === defaultSchema ? name : `${quoteIdent(table.schema, dbType)}.${name}`;
}

// --- helpers for errors and autocomplete -----------------------------------------------------

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return prev[b.length];
}

/** Closest candidate to `name` (case-insensitive), or null when nothing is close enough to be a typo. */
export function closestName(name: string, candidates: string[]): string | null {
  const target = name.toLowerCase();
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of new Set(candidates)) {
    const distance = editDistance(target, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const allowed = Math.max(1, Math.min(3, Math.floor(target.length / 3)));
  return best !== null && bestDistance > 0 && bestDistance <= allowed ? best : null;
}

export interface MissingIdentifier {
  kind: "column" | "table";
  name: string;
}

/** `column "x" does not exist` (Postgres) or `Unknown identifier 'x'` (ClickHouse). */
export function parseMissingIdentifier(message: string): MissingIdentifier | null {
  let m = /column "([^"]+)" (?:of relation "[^"]+" )?does not exist/i.exec(message);
  if (m) return { kind: "column", name: m[1].split(".").pop() ?? m[1] };
  m = /relation "([^"]+)" does not exist/i.exec(message);
  if (m) return { kind: "table", name: m[1].split(".").pop() ?? m[1] };
  m = /Unknown (?:expression or function )?identifier [`'"]([^`'"]+)[`'"]/i.exec(message);
  if (m) return { kind: "column", name: m[1].split(".").pop() ?? m[1] };
  m = /Table ([\w.]+) (?:does not exist|doesn't exist)/i.exec(message);
  if (m) return { kind: "table", name: m[1].split(".").pop() ?? m[1] };
  return null;
}

/** alias (or bare table name) -> table name, for `from customers c join orders as o`. */
export function parseAliases(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  const text = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const re = /\b(?:from|join|update|into)\s+((?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*))?)(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/gi;
  const stop = new Set(["where", "on", "using", "left", "right", "inner", "outer", "full", "cross", "join", "group", "order", "limit", "offset", "having", "union", "set", "values", "select", "natural", "window", "returning", "lateral", "except", "intersect", "format", "settings", "final", "sample", "prewhere", "array"]);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const table = m[1].split(".").pop()!.replace(/^["`]|["`]$/g, "");
    map.set(table.toLowerCase(), table);
    const alias = m[2];
    if (alias && !stop.has(alias.toLowerCase())) map.set(alias.toLowerCase(), table);
  }
  return map;
}
