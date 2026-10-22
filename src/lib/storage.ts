import { invoke } from "@tauri-apps/api/core";
import {
  normalizeConnection,
  normalizeQueriesByScope,
  normalizeResultsByScope,
  readLegacyLocalStorage,
} from "./normalize";
import { savePassword } from "./secrets";
import { emptyAppData, type AppData, type Connection } from "../types/app";

/**
 * App data lives in JSON files in the app data directory (see storage.rs), one file per slice so
 * that saving a connection never rewrites megabytes of saved results.
 */

export type SliceName = "connections" | "queries" | "results";
const VERSION = 2;
const LEGACY_KEYS = ["connections", "savedQueries", "savedResults", "globalSavedQueries", "globalSavedResults"];

export interface LoadResult {
  data: AppData;
  /** Things the user should know about (migration, quarantined files). */
  messages: { kind: "info" | "error"; text: string }[];
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function readSlice(name: SliceName, messages: LoadResult["messages"]): Promise<unknown | null> {
  const text = await invoke<string | null>("storage_read", { name });
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Never overwrite a file we could not read: move it aside first.
    const movedTo = await invoke<string | null>("storage_quarantine", { name }).catch(() => null);
    messages.push({
      kind: "error",
      text: `Saved ${name} could not be read${movedTo ? ` and were moved to ${movedTo}` : ""}. Starting with an empty list.`,
    });
    return null;
  }
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export async function loadAppData(): Promise<LoadResult> {
  const messages: LoadResult["messages"] = [];

  const [rawConnections, rawQueries, rawResults] = await Promise.all([
    readSlice("connections", messages),
    readSlice("queries", messages),
    readSlice("results", messages),
  ]);

  if (rawConnections === null && rawQueries === null && rawResults === null) {
    const migrated = await migrateLegacyStorage(messages);
    if (migrated) return { data: migrated, messages };
    return { data: emptyAppData(), messages };
  }

  const connectionsFile = asRecord(rawConnections);
  const connections: Connection[] = (Array.isArray(connectionsFile.connections) ? connectionsFile.connections : [])
    .map((raw) => normalizeConnection(raw)?.connection)
    .filter((c): c is Connection => c !== undefined);
  const storedActive = connectionsFile.activeConnectionId;
  const activeConnectionId =
    typeof storedActive === "string" && connections.some((c) => c.id === storedActive)
      ? storedActive
      : (connections[0]?.id ?? null);

  return {
    data: {
      connections,
      activeConnectionId,
      queries: normalizeQueriesByScope(asRecord(rawQueries).byScope),
      results: normalizeResultsByScope(asRecord(rawResults).byScope),
    },
    messages,
  };
}

/** Moves data (and plaintext passwords!) from the old localStorage layout into files + keychain. */
async function migrateLegacyStorage(messages: LoadResult["messages"]): Promise<AppData | null> {
  const legacy = readLegacyLocalStorage((key) => localStorage.getItem(key));
  if (!legacy) return null;

  const failures: string[] = [];
  for (const [id, password] of Object.entries(legacy.legacyPasswords)) {
    try {
      await savePassword(id, password);
    } catch (error) {
      failures.push(errorText(error));
    }
  }

  const data: AppData = {
    connections: legacy.connections,
    activeConnectionId: legacy.activeConnectionId,
    queries: legacy.queries,
    results: legacy.results,
  };

  try {
    await writeAll(data);
  } catch (error) {
    // Keep the legacy copy: it is the only one left.
    messages.push({ kind: "error", text: `Could not migrate saved data: ${errorText(error)}` });
    return data;
  }

  for (const key of LEGACY_KEYS) localStorage.removeItem(key);

  const moved = Object.keys(legacy.legacyPasswords).length - failures.length;
  if (moved > 0) {
    messages.push({
      kind: "info",
      text: `${moved} saved password${moved === 1 ? " was" : "s were"} moved from plain app storage to the system keychain.`,
    });
  }
  if (failures.length > 0) {
    messages.push({
      kind: "error",
      text: `${failures.length} password${failures.length === 1 ? "" : "s"} could not be moved to the keychain (${failures[0]}). Re-enter ${failures.length === 1 ? "it" : "them"} by editing the connection.`,
    });
  }
  return data;
}

export function serializeSlice(name: SliceName, data: AppData): string {
  switch (name) {
    case "connections":
      return JSON.stringify(
        { version: VERSION, activeConnectionId: data.activeConnectionId, connections: data.connections },
        null,
        2,
      );
    case "queries":
      return JSON.stringify({ version: VERSION, byScope: data.queries }, null, 2);
    case "results":
      return JSON.stringify({ version: VERSION, byScope: data.results });
  }
}

export const writeSlice = (name: SliceName, data: AppData) =>
  invoke<void>("storage_write", { name, content: serializeSlice(name, data) });

const writeAll = async (data: AppData) => {
  await Promise.all((["connections", "queries", "results"] as const).map((name) => writeSlice(name, data)));
};
