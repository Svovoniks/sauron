import { useCallback, useEffect, useRef, useState } from "react";
import {
  addItem,
  mergeBackup,
  removeConnection,
  removeItem,
  reorderConnections,
  reorderItems,
  setActiveConnection,
  toBackupFile,
  updateItem,
  upsertConnection,
} from "../lib/appDataOps";
import type { Backup } from "../lib/normalize";
import { deletePassword, getPassword, savePassword } from "../lib/secrets";
import { loadAppData, writeSlice, type SliceName } from "../lib/storage";
import {
  emptyAppData,
  type AppData,
  type Connection,
  type ConnectionDraft,
  type SavedQuery,
  type SavedResult,
} from "../types/app";

type Notify = (kind: "info" | "error", text: string) => void;

const SAVE_DELAY_MS = 200;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * All persisted app data plus the operations on it. Every change is written to disk (debounced,
 * one file per slice) - nothing is persisted until the initial load has finished, so a failed
 * load can never overwrite existing data with an empty default.
 */
export function useAppData(notify: Notify) {
  const [data, setData] = useState<AppData>(emptyAppData);
  const [loaded, setLoaded] = useState(false);
  const dataRef = useRef(data);
  dataRef.current = data;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    let cancelled = false;
    loadAppData()
      .then(({ data: loadedData, messages }) => {
        if (cancelled) return;
        setData(loadedData);
        setLoaded(true);
        messages.forEach((message) => notifyRef.current(message.kind, message.text));
      })
      .catch((error) => {
        // Leave `loaded` false: saving is disabled so existing files are not overwritten.
        notifyRef.current("error", `Could not load saved data: ${errorText(error)}. Changes will not be saved.`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- persistence -------------------------------------------------------------------------
  const dirty = useRef(new Set<SliceName>());
  const timers = useRef(new Map<SliceName, number>());

  const flush = useCallback((name: SliceName) => {
    timers.current.delete(name);
    dirty.current.delete(name);
    writeSlice(name, dataRef.current).catch((error) =>
      notifyRef.current("error", `Could not save ${name}: ${errorText(error)}`),
    );
  }, []);

  const schedule = useCallback(
    (name: SliceName) => {
      dirty.current.add(name);
      window.clearTimeout(timers.current.get(name));
      timers.current.set(name, window.setTimeout(() => flush(name), SAVE_DELAY_MS));
    },
    [flush],
  );

  useEffect(() => {
    if (loaded) schedule("connections");
  }, [loaded, data.connections, data.activeConnectionId, schedule]);
  useEffect(() => {
    if (loaded) schedule("queries");
  }, [loaded, data.queries, schedule]);
  useEffect(() => {
    if (loaded) schedule("results");
  }, [loaded, data.results, schedule]);

  // Best effort: write pending changes when the window is hidden or closing.
  useEffect(() => {
    const flushAll = () => [...dirty.current].forEach((name) => flush(name));
    const onVisibility = () => document.visibilityState === "hidden" && flushAll();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flushAll);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flushAll);
    };
  }, [flush]);

  // --- connections -------------------------------------------------------------------------
  /** Returns false (and tells the user) when the password could not be stored. */
  const saveConnection = useCallback(async (draft: ConnectionDraft): Promise<boolean> => {
    const { password, ...rest } = draft;
    const connection: Connection = { ...rest, id: rest.id || crypto.randomUUID() };
    if (password !== "") {
      try {
        await savePassword(connection.id, password);
      } catch (error) {
        notifyRef.current("error", errorText(error));
        return false;
      }
    }
    setData((current) => upsertConnection(current, connection));
    return true;
  }, []);

  const deleteConnection = useCallback((id: string) => {
    deletePassword(id).catch((error) => notifyRef.current("error", errorText(error)));
    setData((current) => removeConnection(current, id));
  }, []);

  const selectConnection = useCallback((id: string) => setData((d) => setActiveConnection(d, id)), []);
  const moveConnection = useCallback(
    (fromId: string, toId: string) => setData((d) => reorderConnections(d, fromId, toId)),
    [],
  );

  // --- saved queries / results ---------------------------------------------------------------
  const addQuery = useCallback(
    (scope: string, query: SavedQuery) => setData((d) => addItem(d, "queries", scope, query)),
    [],
  );
  const removeQuery = useCallback(
    (scope: string, id: string) => setData((d) => removeItem(d, "queries", scope, id)),
    [],
  );
  const overwriteQuery = useCallback(
    (scope: string, id: string, query: string) => setData((d) => updateItem(d, "queries", scope, id, { query })),
    [],
  );
  const moveQuery = useCallback(
    (scope: string, fromId: string, toId: string) => setData((d) => reorderItems(d, "queries", scope, fromId, toId)),
    [],
  );

  const addResult = useCallback(
    (scope: string, result: SavedResult) => setData((d) => addItem(d, "results", scope, result)),
    [],
  );
  const removeResult = useCallback(
    (scope: string, id: string) => setData((d) => removeItem(d, "results", scope, id)),
    [],
  );
  const overwriteResult = useCallback(
    (scope: string, id: string, patch: Partial<SavedResult>) =>
      setData((d) => updateItem(d, "results", scope, id, patch)),
    [],
  );
  const moveResult = useCallback(
    (scope: string, fromId: string, toId: string) => setData((d) => reorderItems(d, "results", scope, fromId, toId)),
    [],
  );

  // --- backup --------------------------------------------------------------------------------
  /** `includePasswords` reads every saved password from the keychain and writes it in plain text. */
  const exportText = useCallback(async (includePasswords: boolean) => {
    const current = dataRef.current;
    const passwords: Record<string, string> = {};
    if (includePasswords) {
      for (const connection of current.connections) {
        const password = await getPassword(connection.id);
        if (password) passwords[connection.id] = password;
      }
    }
    return JSON.stringify(toBackupFile(current, passwords), null, 2);
  }, []);

  const importBackup = useCallback(async (backup: Backup) => {
    const failures: string[] = [];
    for (const [id, password] of Object.entries(backup.legacyPasswords)) {
      try {
        await savePassword(id, password);
      } catch (error) {
        failures.push(errorText(error));
      }
    }
    if (failures.length > 0) {
      notifyRef.current("error", `${failures.length} password(s) in the file could not be saved: ${failures[0]}`);
    }
    setData((current) => mergeBackup(current, backup));
  }, []);

  return {
    data,
    loaded,
    saveConnection,
    deleteConnection,
    selectConnection,
    moveConnection,
    addQuery,
    removeQuery,
    overwriteQuery,
    moveQuery,
    addResult,
    removeResult,
    overwriteResult,
    moveResult,
    exportText,
    importBackup,
  };
}
