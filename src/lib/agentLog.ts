/** What AI agents did through `sauron --mcp` (see agent_log.rs). Written by the MCP server, only read and cleared here. */

import type { Cell, ColumnMeta } from "../types/app";

export type AgentStatus = "ok" | "error" | "blocked";
export type AgentTool = "query" | "list_tables" | "describe_table" | "list_connections";

export interface AgentEntry {
  id: string;
  /** ms since epoch */
  at: number;
  /** The agent, as it introduced itself, e.g. "claude-code". */
  client: string;
  tool: AgentTool | string;
  connection_id: string;
  connection_name: string;
  /** What ran: the SQL, or the catalog command of list_tables / describe_table. */
  sql: string;
  ms: number;
  status: AgentStatus;
  /** Text the agent got back; empty when it got a table (see `rows`). */
  output: string;
  /** Rows of the table the agent got, null when it got text. */
  rows: number | null;
  truncated: boolean;
}

export interface AgentTable {
  columns: ColumnMeta[];
  rows: Cell[][];
  truncated: boolean;
  message: string | null;
}

export type AgentFilter = "all" | "queries" | "problems" | "connection";

export const TOOL_LABEL: Record<string, string> = {
  query: "query",
  list_tables: "list tables",
  describe_table: "describe",
  list_connections: "list connections",
};

/** One line for the list: the SQL, or what the call was about when nothing ran. */
export const agentSummary = (entry: AgentEntry): string =>
  entry.sql || (entry.tool === "list_connections" ? "Listed the saved connections" : TOOL_LABEL[entry.tool] ?? entry.tool);

export function filterAgentEntries(entries: AgentEntry[], filter: AgentFilter, search: string, connectionId: string | null): AgentEntry[] {
  const q = search.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      (filter === "all" ||
        (filter === "queries" && entry.tool === "query") ||
        (filter === "problems" && entry.status !== "ok") ||
        (filter === "connection" && entry.connection_id === connectionId)) &&
      (!q || `${entry.sql}\n${entry.output}\n${entry.connection_name}\n${entry.client}`.toLowerCase().includes(q)),
  );
}
