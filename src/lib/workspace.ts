import type { Connection } from "../types/app";
import type { QueryTab } from "../types/workspace";

/** Pure helpers for query tabs. */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const MAX_TABS = 40;
const MAX_TAB_SQL = 2_000_000;

export const newTab = (init: Partial<QueryTab> = {}, existing: QueryTab[] = []): QueryTab => ({
  id: crypto.randomUUID(),
  name: init.name ?? nextUntitledName(existing),
  connectionId: null,
  sql: "",
  savedQueryId: null,
  savedScope: null,
  pinned: false,
  ...init,
});

export function nextUntitledName(tabs: QueryTab[]): string {
  const used = new Set(tabs.map((tab) => tab.name));
  for (let n = 1; ; n++) {
    const name = `untitled ${n}`;
    if (!used.has(name)) return name;
  }
}

export interface SessionFile {
  activeTabId: string | null;
  tabs: QueryTab[];
}

export function normalizeSession(raw: unknown, connections: Connection[]): SessionFile {
  if (!isRecord(raw) || !Array.isArray(raw.tabs)) return { activeTabId: null, tabs: [] };
  const known = new Set(connections.map((c) => c.id));
  const seen = new Set<string>();
  const tabs: QueryTab[] = [];
  for (const item of raw.tabs.slice(0, MAX_TABS)) {
    if (!isRecord(item) || typeof item.sql !== "string") continue;
    let id = typeof item.id === "string" && item.id ? item.id : crypto.randomUUID();
    if (seen.has(id)) id = crypto.randomUUID();
    seen.add(id);
    tabs.push({
      id,
      name: typeof item.name === "string" && item.name.trim() ? item.name.slice(0, 80) : "untitled",
      connectionId: typeof item.connectionId === "string" && known.has(item.connectionId) ? item.connectionId : null,
      sql: item.sql.slice(0, MAX_TAB_SQL),
      savedQueryId: typeof item.savedQueryId === "string" ? item.savedQueryId : null,
      savedScope: typeof item.savedScope === "string" ? item.savedScope : null,
      pinned: item.pinned === true,
    });
  }
  const active = typeof raw.activeTabId === "string" && seen.has(raw.activeTabId) ? raw.activeTabId : (tabs[0]?.id ?? null);
  return { activeTabId: active, tabs };
}

export const serializeSession = (session: SessionFile) => JSON.stringify({ version: 1, ...session });

/** Pinned tabs stay on the left, in their relative order. */
export function sortPinned(tabs: QueryTab[]): QueryTab[] {
  return [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
}

/** Tab to show after closing `closedId` (the neighbour to the right, else to the left). */
export function neighbourAfterClose(tabs: QueryTab[], closedId: string): string | null {
  const index = tabs.findIndex((t) => t.id === closedId);
  const rest = tabs.filter((t) => t.id !== closedId);
  if (rest.length === 0) return null;
  return rest[Math.min(index, rest.length - 1)].id;
}

/** Does the tab differ from the saved query it came from (or, for scratch tabs, hold anything at all)? */
export function isDirty(tab: QueryTab, savedText: string | null): boolean {
  if (tab.savedQueryId) return savedText !== null && savedText !== tab.sql;
  return false;
}
