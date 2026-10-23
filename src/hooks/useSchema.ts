import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonFile, writeFileText } from "../lib/fileStore";
import { executeScript } from "../lib/db/query";
import { buildSchema, schemaLoadError, schemaQueries, type Schema } from "../lib/schema";
import type { Connection, StatementOutcome } from "../types/app";

export interface SchemaState {
  schema: Schema | null;
  /** Something is being read (the first time, or a refresh behind a cached copy). */
  loading: boolean;
  /** Tables are known but their columns are still being read. */
  columnsLoading: boolean;
  /** The schema shown comes from the copy saved on disk and is being refreshed. */
  cached: boolean;
  error: string | null;
}

const EMPTY: SchemaState = { schema: null, loading: false, columnsLoading: false, cached: false, error: null };

/** Schemas bigger than this are not written to disk. */
const MAX_CACHE_CHARS = 12_000_000;
const SAVE_DELAY_MS = 1_500;

/** What makes a saved copy still describe the same database. */
const fingerprint = (c: Connection) => `${c.db_type}|${c.host}|${c.port}|${c.database}|${c.username}`;

interface CacheEntry {
  fingerprint: string;
  schema: Schema;
}

/**
 * Per-connection schema: loaded on demand in two steps (table list first, columns after) so the tree shows
 * up quickly, and kept on disk so the next launch starts with the last known schema while a refresh runs.
 */
export function useSchema() {
  const [states, setStates] = useState<Record<string, SchemaState>>({});
  const inFlight = useRef(new Set<string>());
  const statesRef = useRef(states);
  statesRef.current = states;

  // --- disk cache ----------------------------------------------------------------------------
  const cache = useRef<Record<string, CacheEntry> | null>(null);
  const cacheLoading = useRef<Promise<void> | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  const ensureCache = useCallback((): Promise<void> => {
    if (cache.current) return Promise.resolve();
    cacheLoading.current ??= readJsonFile("schema")
      .then((raw) => {
        const entries = (raw as { entries?: Record<string, CacheEntry> } | null)?.entries;
        cache.current = entries && typeof entries === "object" ? entries : {};
      })
      .catch(() => {
        cache.current = {};
      });
    return cacheLoading.current;
  }, []);

  const scheduleSave = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const content = JSON.stringify({ version: 1, entries: cache.current ?? {} });
      if (content.length > MAX_CACHE_CHARS) return;
      writeFileText("schema", content).catch(() => undefined); // only a cache: a failed write costs nothing
    }, SAVE_DELAY_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  // --- loading ---------------------------------------------------------------------------------
  const load = useCallback(
    async (connection: Connection, force = false) => {
      const id = connection.id;
      if (inFlight.current.has(id)) return;
      if (!force && statesRef.current[id]?.schema && !statesRef.current[id]?.cached) return;

      inFlight.current.add(id);
      const patch = (next: Partial<SchemaState>) => setStates((current) => ({ ...(current), [id]: { ...(current[id] ?? EMPTY), ...next } }));
      patch({ loading: true, error: null });

      try {
        // 1. the saved copy, if it describes this database
        if (!statesRef.current[id]?.schema) {
          await ensureCache();
          const saved = cache.current?.[id];
          if (saved && saved.fingerprint === fingerprint(connection)) patch({ schema: saved.schema, cached: true });
        }

        const queries = schemaQueries(connection.db_type);
        const needed = connection.db_type === "postgres" ? 3 : 2;

        // 2. the table list: small and quick
        const tables = await executeScript(connection, queries.slice(0, 1), 300_000, true);
        const tablesError = schemaLoadError(tables, 1);
        if (tablesError) {
          patch({ loading: false, columnsLoading: false, error: tablesError });
          return;
        }
        const withoutColumns = buildSchema(connection.db_type, tables);
        // Keep the columns we already know while they are refreshed, so the tree does not collapse.
        const known = new Map((statesRef.current[id]?.schema?.tables ?? []).map((t) => [`${t.schema}.${t.name}`, t.columns]));
        const merged: Schema = { ...withoutColumns, tables: withoutColumns.tables.map((t) => ({ ...t, columns: known.get(`${t.schema}.${t.name}`) ?? [] })) };
        patch({ schema: merged, cached: false, columnsLoading: true });

        // 3. columns, keys, functions
        const details = await executeScript(connection, queries.slice(1), 300_000, true);
        const all: StatementOutcome[] = [tables[0], ...details];
        const error = schemaLoadError(all, needed);
        if (error) {
          patch({ loading: false, columnsLoading: false, error });
          return;
        }
        const schema = buildSchema(connection.db_type, all);
        patch({ schema, loading: false, columnsLoading: false, cached: false, error: null });
        cache.current = { ...(cache.current ?? {}), [id]: { fingerprint: fingerprint(connection), schema } };
        scheduleSave();
      } catch (error) {
        patch({ loading: false, columnsLoading: false, error: error instanceof Error ? error.message : String(error) });
      } finally {
        inFlight.current.delete(id);
      }
    },
    [ensureCache, scheduleSave],
  );

  /** Show the saved copy right away (no network): autocomplete and the schema tree work before the first query. */
  const restore = useCallback(
    async (connection: Connection) => {
      if (statesRef.current[connection.id]?.schema) return;
      await ensureCache();
      const saved = cache.current?.[connection.id];
      if (!saved || saved.fingerprint !== fingerprint(connection) || statesRef.current[connection.id]?.schema) return;
      setStates((current) => (current[connection.id]?.schema ? current : { ...current, [connection.id]: { ...EMPTY, schema: saved.schema, cached: true } }));
    },
    [ensureCache],
  );

  const forget = useCallback(
    (id: string) => {
      setStates((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
      if (cache.current && id in cache.current) {
        delete cache.current[id];
        scheduleSave();
      }
    },
    [scheduleSave],
  );

  const get = useCallback((id: string | null): SchemaState => (id ? (states[id] ?? EMPTY) : EMPTY), [states]);

  return { get, load, restore, forget };
}
