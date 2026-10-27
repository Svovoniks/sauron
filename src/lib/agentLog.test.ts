import { describe, expect, test } from "bun:test";
import { agentSummary, filterAgentEntries, type AgentEntry } from "./agentLog";

const entry = (patch: Partial<AgentEntry>): AgentEntry => ({
  id: "1",
  at: 0,
  client: "claude-code",
  tool: "query",
  connection_id: "c1",
  connection_name: "Local",
  sql: "select 1",
  ms: 3,
  status: "ok",
  output: "",
  rows: 1,
  truncated: false,
  ...patch,
});

describe("agent log", () => {
  const entries = [
    entry({ id: "a" }),
    entry({ id: "b", tool: "describe_table", sql: "\\d+ users", connection_id: "c2", output: "Table public.users" }),
    entry({ id: "c", status: "blocked", sql: "delete from users", output: "read-only for agents" }),
    entry({ id: "d", status: "error", sql: "select nope", output: "column nope does not exist" }),
  ];
  const ids = (list: AgentEntry[]) => list.map((e) => e.id);

  test("filters by kind, problems and connection", () => {
    expect(ids(filterAgentEntries(entries, "all", "", null))).toEqual(["a", "b", "c", "d"]);
    expect(ids(filterAgentEntries(entries, "queries", "", null))).toEqual(["a", "c", "d"]);
    expect(ids(filterAgentEntries(entries, "problems", "", null))).toEqual(["c", "d"]);
    expect(ids(filterAgentEntries(entries, "connection", "", "c2"))).toEqual(["b"]);
  });

  test("searches the SQL and what the agent got back", () => {
    expect(ids(filterAgentEntries(entries, "all", "USERS", null))).toEqual(["b", "c"]);
    expect(ids(filterAgentEntries(entries, "all", "does not exist", null))).toEqual(["d"]);
  });

  test("summary falls back to the tool when nothing ran", () => {
    expect(agentSummary(entry({ tool: "list_connections", sql: "" }))).toBe("Listed the saved connections");
    expect(agentSummary(entry({}))).toBe("select 1");
  });
});
