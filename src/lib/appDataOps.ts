import type { Backup } from "./normalize";
import { GLOBAL_SCOPE, type AppData, type Connection, type SavedQuery, type SavedResult } from "../types/app";

/** Pure state transitions for AppData. */

type ListKey = "queries" | "results";
type ItemOf<K extends ListKey> = K extends "queries" ? SavedQuery : SavedResult;

export const reorderById = <T extends { id: string }>(items: T[], fromId: string, toId: string): T[] => {
  const fromIndex = items.findIndex((item) => item.id === fromId);
  const toIndex = items.findIndex((item) => item.id === toId);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return items;

  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
};

function withList<K extends ListKey>(
  data: AppData,
  key: K,
  scope: string,
  change: (items: ItemOf<K>[]) => ItemOf<K>[],
): AppData {
  const current = (data[key][scope] ?? []) as ItemOf<K>[];
  const next = change(current);
  if (next === current) return data;
  return { ...data, [key]: { ...data[key], [scope]: next } };
}

export const itemsOf = <K extends ListKey>(data: AppData, key: K, scope: string): ItemOf<K>[] =>
  (data[key][scope] ?? []) as ItemOf<K>[];

export const addItem = <K extends ListKey>(data: AppData, key: K, scope: string, item: ItemOf<K>): AppData =>
  withList(data, key, scope, (items) => [...items, item]);

export const removeItem = <K extends ListKey>(data: AppData, key: K, scope: string, id: string): AppData =>
  withList(data, key, scope, (items) => {
    const next = items.filter((item) => item.id !== id);
    return next.length === items.length ? items : next;
  });

export const updateItem = <K extends ListKey>(
  data: AppData,
  key: K,
  scope: string,
  id: string,
  patch: Partial<ItemOf<K>>,
): AppData =>
  withList(data, key, scope, (items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));

export const reorderItems = <K extends ListKey>(
  data: AppData,
  key: K,
  scope: string,
  fromId: string,
  toId: string,
): AppData => withList(data, key, scope, (items) => reorderById(items, fromId, toId));

// --- connections -------------------------------------------------------------------------------

export function upsertConnection(data: AppData, connection: Connection): AppData {
  const exists = data.connections.some((c) => c.id === connection.id);
  const connections = exists
    ? data.connections.map((c) => (c.id === connection.id ? connection : c))
    : [...data.connections, connection];
  return {
    ...data,
    connections,
    activeConnectionId: data.activeConnectionId ?? connection.id,
  };
}

export function removeConnection(data: AppData, id: string): AppData {
  const connections = data.connections.filter((c) => c.id !== id);
  const { [id]: _removedQueries, ...queries } = data.queries;
  const { [id]: _removedResults, ...results } = data.results;
  const stillActive = connections.some((c) => c.id === data.activeConnectionId);
  return {
    connections,
    activeConnectionId: stillActive ? data.activeConnectionId : (connections[0]?.id ?? null),
    queries,
    results,
  };
}

export function setActiveConnection(data: AppData, id: string): AppData {
  if (data.activeConnectionId === id || !data.connections.some((c) => c.id === id)) return data;
  return { ...data, activeConnectionId: id };
}

export function reorderConnections(data: AppData, fromId: string, toId: string): AppData {
  const connections = reorderById(data.connections, fromId, toId);
  return connections === data.connections ? data : { ...data, connections };
}

// --- backup ------------------------------------------------------------------------------------

/**
 * Export file. Passwords stay in the OS keychain unless `passwords` (connection id -> password) is given,
 * in which case they are written in PLAIN TEXT into the file as a `password` field (the importer reads them back).
 */
export function toBackupFile(data: AppData, passwords: Record<string, string> = {}) {
  const { [GLOBAL_SCOPE]: globalQueries = [], ...queries } = data.queries;
  const { [GLOBAL_SCOPE]: globalResults = [], ...results } = data.results;
  const connections = data.connections.map((connection) =>
    passwords[connection.id] ? { ...connection, password: passwords[connection.id] } : connection,
  );
  return { connections, queries, results, globalQueries, globalResults };
}

/** Imported items are added to the existing data; items with the same id replace the existing ones. */
export function mergeBackup(data: AppData, backup: Backup): AppData {
  const connections = [...data.connections];
  for (const incoming of backup.connections) {
    const index = connections.findIndex((c) => c.id === incoming.id);
    if (index === -1) connections.push(incoming);
    else connections[index] = incoming;
  }

  const mergeScopes = <T extends { id: string }>(
    existing: Record<string, T[]>,
    incoming: Record<string, T[]>,
  ): Record<string, T[]> => {
    const merged: Record<string, T[]> = { ...existing };
    for (const [scope, items] of Object.entries(incoming)) {
      const list = [...(merged[scope] ?? [])];
      for (const item of items) {
        const index = list.findIndex((i) => i.id === item.id);
        if (index === -1) list.push(item);
        else list[index] = item;
      }
      merged[scope] = list;
    }
    return merged;
  };

  return {
    connections,
    activeConnectionId: data.activeConnectionId ?? connections[0]?.id ?? null,
    queries: mergeScopes(data.queries, backup.queries),
    results: mergeScopes(data.results, backup.results),
  };
}
