import {
  GLOBAL_SCOPE,
  type Cell,
  type ColumnMeta,
  type Connection,
  type DbType,
  type Env,
  ENVS,
  type SavedQuery,
  type SavedResult,
  type SslMode,
} from "../types/app";

/**
 * Defensive normalisation of untrusted stored / imported data.
 * Every function takes `unknown`, never throws and returns values whose string fields are real strings.
 */

type UnknownRecord = Record<string, unknown>;

const isRecord = (v: unknown): v is UnknownRecord => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const uuid = () => crypto.randomUUID();
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const idOrNew = (v: unknown): string => (str(v).trim() === "" || DANGEROUS_KEYS.has(str(v)) ? uuid() : str(v));
const DB_TYPES: readonly string[] = ["postgres", "clickhouse"];
const SSL_MODES: readonly string[] = ["disable", "prefer", "require", "verify"];

const isDbType = (v: unknown): v is DbType => typeof v === "string" && DB_TYPES.includes(v);
const isSslMode = (v: unknown): v is SslMode => typeof v === "string" && SSL_MODES.includes(v);

const SCHEME = /^https?:\/\//i;

// --- connections -------------------------------------------------------------------------------

export function normalizeConnection(raw: unknown): { connection: Connection; legacyPassword: string | null } | null {
  if (!isRecord(raw)) return null;

  const db_type: DbType = isDbType(raw.db_type) ? raw.db_type : "postgres";

  let host = str(raw.host).trim();
  const hadHttps = /^https:\/\//i.test(host);
  if (db_type === "clickhouse") {
    host = host.replace(SCHEME, "").replace(/\/+$/, "");
  }

  let ssl_mode: SslMode;
  if (isSslMode(raw.ssl_mode)) {
    ssl_mode = raw.ssl_mode;
  } else if (db_type === "postgres") {
    ssl_mode = "prefer";
  } else {
    ssl_mode = hadHttps ? "verify" : "disable";
  }

  let port = "";
  if (typeof raw.port === "string") port = raw.port.trim();
  else if (typeof raw.port === "number" && Number.isFinite(raw.port)) port = String(raw.port);

  const timeout = raw.timeout_secs;
  const timeout_secs = typeof timeout === "number" && Number.isInteger(timeout) && timeout >= 0 ? timeout : 0;

  const connection: Connection = {
    id: idOrNew(raw.id),
    name: str(raw.name),
    host,
    port,
    username: str(raw.username).trim(),
    database: str(raw.database).trim(),
    db_type,
    ssl_mode,
    read_only: typeof raw.read_only === "boolean" ? raw.read_only : false,
    timeout_secs,
    env: typeof raw.env === "string" && (ENVS as readonly string[]).includes(raw.env) ? (raw.env as Env) : "",
  };

  const legacyPassword = typeof raw.password === "string" && raw.password !== "" ? raw.password : null;
  return { connection, legacyPassword };
}

/**
 * Normalises a list of raw connections, dropping garbage entries and re-id'ing duplicate ids.
 * `ids[k]` is the final id of `rawList[k]` (null when that entry was dropped).
 */
function collectConnections(rawList: unknown[]): {
  connections: Connection[];
  legacyPasswords: Record<string, string>;
  ids: (string | null)[];
} {
  const connections: Connection[] = [];
  const legacyPasswords = new Map<string, string>();
  const seen = new Set<string>();
  const ids: (string | null)[] = [];

  for (const item of rawList) {
    const parsed = normalizeConnection(item);
    if (!parsed) {
      ids.push(null);
      continue;
    }
    let { connection } = parsed;
    if (seen.has(connection.id)) connection = { ...connection, id: uuid() };
    seen.add(connection.id);
    connections.push(connection);
    ids.push(connection.id);
    if (parsed.legacyPassword !== null) legacyPasswords.set(connection.id, parsed.legacyPassword);
  }

  return { connections, legacyPasswords: Object.fromEntries(legacyPasswords), ids };
}

// --- saved queries -----------------------------------------------------------------------------

export function normalizeSavedQuery(raw: unknown): SavedQuery | null {
  if (!isRecord(raw)) return null;
  return { id: idOrNew(raw.id), name: str(raw.name), query: str(raw.query) };
}

// --- saved results -----------------------------------------------------------------------------

function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  try {
    return JSON.stringify(v) ?? null;
  } catch {
    return null;
  }
}

function fitRow(cells: Cell[], width: number): Cell[] {
  if (cells.length === width) return cells;
  if (cells.length > width) return cells.slice(0, width);
  return [...cells, ...new Array<Cell>(width - cells.length).fill(null)];
}

function normalizeColumn(raw: unknown): ColumnMeta {
  if (typeof raw === "string") return { name: raw, type: "string" };
  if (isRecord(raw)) return { name: str(raw.name), type: str(raw.type) || "string" };
  return { name: "", type: "string" };
}

function columnTypeOf(values: unknown[]): string {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (present.length === 0) return "string";
  if (present.every((v) => typeof v === "number")) return "number";
  if (present.every((v) => typeof v === "boolean")) return "bool";
  return "string";
}

export function normalizeSavedResult(raw: unknown): SavedResult | null {
  if (!isRecord(raw)) return null;
  const base = { id: idOrNew(raw.id), name: str(raw.name), query: str(raw.query) };

  if (Array.isArray(raw.columns)) {
    const columns = raw.columns.map(normalizeColumn);
    const rows: Cell[][] = [];
    if (Array.isArray(raw.rows)) {
      for (const row of raw.rows) {
        if (Array.isArray(row)) rows.push(fitRow(row.map(toCell), columns.length));
      }
    }
    return { ...base, columns, rows, truncated: raw.truncated === true };
  }

  if (Array.isArray(raw.records)) {
    const maps: Map<string, unknown>[] = [];
    const order: string[] = [];
    const known = new Set<string>();
    for (const rec of raw.records) {
      if (!isRecord(rec)) continue;
      const map = new Map<string, unknown>(Object.entries(rec));
      for (const key of map.keys()) {
        if (!known.has(key)) {
          known.add(key);
          order.push(key);
        }
      }
      maps.push(map);
    }
    const columns: ColumnMeta[] = order.map((name) => ({
      name,
      type: columnTypeOf(maps.map((m) => m.get(name))),
    }));
    const rows = maps.map((m) => order.map((name) => toCell(m.get(name))));
    return { ...base, columns, rows, truncated: raw.truncated === true };
  }

  return null;
}

// --- scoped collections ------------------------------------------------------------------------

function normalizeByScope<T>(raw: unknown, normalizeItem: (item: unknown) => T | null): Record<string, T[]> {
  if (!isRecord(raw)) return {};
  const entries: [string, T[]][] = [];
  for (const [scope, items] of Object.entries(raw)) {
    if (DANGEROUS_KEYS.has(scope) || !Array.isArray(items)) continue;
    const list: T[] = [];
    for (const item of items) {
      const normalized = normalizeItem(item);
      if (normalized) list.push(normalized);
    }
    entries.push([scope, list]);
  }
  return Object.fromEntries(entries);
}

export function normalizeQueriesByScope(raw: unknown): Record<string, SavedQuery[]> {
  return normalizeByScope(raw, normalizeSavedQuery);
}

export function normalizeResultsByScope(raw: unknown): Record<string, SavedResult[]> {
  return normalizeByScope(raw, normalizeSavedResult);
}

function normalizeList<T>(raw: unknown, normalizeItem: (item: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const item of raw) {
    const normalized = normalizeItem(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

function addToScope<T>(target: Record<string, T[]>, scope: string, items: T[]) {
  if (items.length === 0) return;
  const existing = Object.prototype.hasOwnProperty.call(target, scope) ? target[scope] : [];
  Object.defineProperty(target, scope, {
    value: [...existing, ...items],
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

// --- backup file -------------------------------------------------------------------------------

export interface Backup {
  connections: Connection[];
  /** connection id -> password found in the (legacy) file */
  legacyPasswords: Record<string, string>;
  queries: Record<string, SavedQuery[]>;
  results: Record<string, SavedResult[]>;
}

function pickScopes<T>(scopes: Record<string, T[]>, allowed: Set<string>): Record<string, T[]> {
  return Object.fromEntries(Object.entries(scopes).filter(([scope]) => allowed.has(scope)));
}

export function normalizeBackup(raw: unknown): Backup | null {
  let rawConnections: unknown[];
  let rawQueries: unknown = undefined;
  let rawResults: unknown = undefined;
  let globalQueries: unknown[] = [];
  let globalResults: unknown[] = [];

  if (Array.isArray(raw)) {
    rawConnections = raw;
  } else if (isRecord(raw)) {
    const gq = Array.isArray(raw.globalQueries) ? raw.globalQueries : null;
    const gr = Array.isArray(raw.globalResults) ? raw.globalResults : null;
    if (!Array.isArray(raw.connections) && !gq && !gr) return null;
    rawConnections = Array.isArray(raw.connections) ? raw.connections : [];
    rawQueries = raw.queries;
    rawResults = raw.results;
    globalQueries = gq ?? [];
    globalResults = gr ?? [];
  } else {
    return null;
  }

  const { connections, legacyPasswords } = collectConnections(rawConnections);
  const allowed = new Set<string>([GLOBAL_SCOPE, ...connections.map((c) => c.id)]);

  const queries = pickScopes(normalizeQueriesByScope(rawQueries), allowed);
  const results = pickScopes(normalizeResultsByScope(rawResults), allowed);
  addToScope(queries, GLOBAL_SCOPE, normalizeList(globalQueries, normalizeSavedQuery));
  addToScope(results, GLOBAL_SCOPE, normalizeList(globalResults, normalizeSavedResult));

  return { connections, legacyPasswords, queries, results };
}

// --- legacy localStorage -----------------------------------------------------------------------

export interface LegacyLocalStorage {
  connections: Connection[];
  legacyPasswords: Record<string, string>;
  activeConnectionId: string | null;
  queries: Record<string, SavedQuery[]>;
  results: Record<string, SavedResult[]>;
}

/** Reads one localStorage key as JSON. `exists` is true when the key is present, even if its JSON is corrupt. */
function readJson(get: (key: string) => string | null, key: string): { exists: boolean; value: unknown } {
  let text: string | null;
  try {
    text = get(key);
  } catch {
    return { exists: false, value: undefined };
  }
  if (typeof text !== "string") return { exists: false, value: undefined };
  try {
    return { exists: true, value: JSON.parse(text) as unknown };
  } catch {
    return { exists: true, value: undefined };
  }
}

export function readLegacyLocalStorage(get: (key: string) => string | null): LegacyLocalStorage | null {
  const rawConnections = readJson(get, "connections");
  const rawQueries = readJson(get, "savedQueries");
  const rawResults = readJson(get, "savedResults");
  const rawGlobalQueries = readJson(get, "globalSavedQueries");
  const rawGlobalResults = readJson(get, "globalSavedResults");

  if (![rawConnections, rawQueries, rawResults, rawGlobalQueries, rawGlobalResults].some((r) => r.exists)) {
    return null;
  }

  const list = Array.isArray(rawConnections.value) ? rawConnections.value : [];
  const { connections, legacyPasswords, ids } = collectConnections(list);

  let activeConnectionId: string | null = null;
  const activeIndex = list.findIndex((c) => isRecord(c) && c.active === true);
  if (activeIndex !== -1) activeConnectionId = ids[activeIndex] ?? null;
  if (activeConnectionId === null) activeConnectionId = connections[0]?.id ?? null;

  const firstId = connections[0]?.id;

  let queries: Record<string, SavedQuery[]> = {};
  if (Array.isArray(rawQueries.value)) {
    // Oldest layout: one bare array belonging to the first connection.
    if (firstId !== undefined) addToScope(queries, firstId, normalizeList(rawQueries.value, normalizeSavedQuery));
  } else {
    queries = normalizeQueriesByScope(rawQueries.value);
  }

  let results: Record<string, SavedResult[]> = {};
  if (Array.isArray(rawResults.value)) {
    if (firstId !== undefined) addToScope(results, firstId, normalizeList(rawResults.value, normalizeSavedResult));
  } else {
    results = normalizeResultsByScope(rawResults.value);
  }

  addToScope(queries, GLOBAL_SCOPE, normalizeList(rawGlobalQueries.value, normalizeSavedQuery));
  addToScope(results, GLOBAL_SCOPE, normalizeList(rawGlobalResults.value, normalizeSavedResult));

  return { connections, legacyPasswords, activeConnectionId, queries, results };
}
