/** Query history: what was run, where and how it went. Never contains result rows. */

export type HistoryStatus = "ok" | "error" | "cancelled";

export interface HistoryEntry {
  id: string;
  /** ms since epoch */
  at: number;
  sql: string;
  connectionId: string;
  /** Connection name when it was run (the connection may be renamed or deleted later). */
  connectionName: string;
  status: HistoryStatus;
  ms: number;
  /** Rows returned by the last statement, or rows affected. */
  rows: number | null;
  affected: boolean;
  truncated: boolean;
  error: string | null;
}

export const MAX_HISTORY = 2_000;
const MAX_SQL_CHARS = 20_000;
const DAY_MS = 86_400_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function normalizeHistory(raw: unknown): HistoryEntry[] {
  const list = isRecord(raw) && Array.isArray(raw.entries) ? raw.entries : [];
  const out: HistoryEntry[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.sql !== "string" || typeof item.at !== "number") continue;
    out.push({
      id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
      at: item.at,
      sql: item.sql.slice(0, MAX_SQL_CHARS),
      connectionId: typeof item.connectionId === "string" ? item.connectionId : "",
      connectionName: typeof item.connectionName === "string" ? item.connectionName : "",
      status: item.status === "error" || item.status === "cancelled" ? item.status : "ok",
      ms: typeof item.ms === "number" && item.ms >= 0 ? item.ms : 0,
      rows: typeof item.rows === "number" ? item.rows : null,
      affected: item.affected === true,
      truncated: item.truncated === true,
      error: typeof item.error === "string" ? item.error.slice(0, 500) : null,
    });
  }
  return out.slice(0, MAX_HISTORY);
}

/** Drops entries older than the retention setting and caps the list. `keep` is the Settings value. */
export function pruneHistory(entries: HistoryEntry[], keep: "off" | "7" | "30" | "forever", now = Date.now()): HistoryEntry[] {
  // "Off" only stops recording; it never deletes what is already stored (Settings has "Clear history" for that).
  if (keep === "off") return entries.length > MAX_HISTORY ? entries.slice(0, MAX_HISTORY) : entries;
  const limit = keep === "forever" ? 0 : Number(keep) * DAY_MS;
  const kept = limit ? entries.filter((entry) => now - entry.at <= limit) : entries;
  return kept.length > MAX_HISTORY ? kept.slice(0, MAX_HISTORY) : kept;
}

export function newEntry(init: Omit<HistoryEntry, "id" | "sql"> & { sql: string }): HistoryEntry {
  return { ...init, id: crypto.randomUUID(), sql: init.sql.slice(0, MAX_SQL_CHARS) };
}

export const formatDuration = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : ms >= 1_000 ? `${(ms / 1_000).toFixed(1)} s` : `${Math.round(ms)} ms`);

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "Today", "Yesterday", "Mon 19 Oct" */
export function dayLabel(at: number, now = new Date()): string {
  const date = new Date(at);
  if (sameDay(date, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" });
}

export const timeLabel = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
