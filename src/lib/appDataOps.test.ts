import { describe, expect, test } from "bun:test";
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
} from "./appDataOps";
import { normalizeBackup } from "./normalize";
import { GLOBAL_SCOPE, emptyAppData, type AppData, type Connection } from "../types/app";

const conn = (id: string): Connection => ({
  id,
  name: id,
  host: "h",
  port: "1",
  username: "u",
  database: "d",
  db_type: "postgres",
  ssl_mode: "require",
  read_only: true,
  timeout_secs: 0,
  env: "",
  description: "",
  ssl_root_cert: "",
  ssl_cert: "",
  ssl_key: "",
  use_default_certs: false,
});
const query = (id: string) => ({ id, name: id, query: `select '${id}'` });

describe("connections", () => {
  test("first connection becomes active, upsert replaces by id", () => {
    let d = upsertConnection(emptyAppData(), conn("a"));
    expect(d.activeConnectionId).toBe("a");
    d = upsertConnection(d, conn("b"));
    expect(d.activeConnectionId).toBe("a");
    d = upsertConnection(d, { ...conn("b"), name: "renamed" });
    expect(d.connections.map((c) => c.name)).toEqual(["a", "renamed"]);
  });

  test("removing the active connection activates the first remaining one and drops its saved items", () => {
    let d: AppData = emptyAppData();
    d = upsertConnection(upsertConnection(d, conn("a")), conn("b"));
    d = addItem(d, "queries", "a", query("q1"));
    d = addItem(d, "queries", GLOBAL_SCOPE, query("g1"));
    const next = removeConnection(d, "a");
    expect(next.activeConnectionId).toBe("b");
    expect(Object.keys(next.queries)).toEqual([GLOBAL_SCOPE]);
    expect(d.connections).toHaveLength(2); // input untouched
    expect(removeConnection(next, "b").activeConnectionId).toBeNull();
  });

  test("setActiveConnection ignores unknown ids; reorder is a no-op for unknown ids", () => {
    const d = upsertConnection(upsertConnection(emptyAppData(), conn("a")), conn("b"));
    expect(setActiveConnection(d, "zzz")).toBe(d);
    expect(setActiveConnection(d, "b").activeConnectionId).toBe("b");
    expect(reorderConnections(d, "a", "zzz")).toBe(d);
    expect(reorderConnections(d, "a", "b").connections.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("saved lists", () => {
  test("add, update, reorder, remove", () => {
    let d = emptyAppData();
    d = addItem(d, "queries", "s", query("1"));
    d = addItem(d, "queries", "s", query("2"));
    d = updateItem(d, "queries", "s", "1", { query: "changed" });
    expect(d.queries.s[0].query).toBe("changed");
    d = reorderItems(d, "queries", "s", "1", "2");
    expect(d.queries.s.map((q) => q.id)).toEqual(["2", "1"]);
    d = removeItem(d, "queries", "s", "2");
    expect(d.queries.s.map((q) => q.id)).toEqual(["1"]);
  });

  test("operations do not mutate their input and return the same object when nothing changes", () => {
    const d = addItem(emptyAppData(), "queries", "s", query("1"));
    expect(removeItem(d, "queries", "s", "nope")).toBe(d);
    expect(reorderItems(d, "queries", "s", "1", "1")).toBe(d);
    const before = JSON.stringify(d);
    updateItem(d, "queries", "s", "1", { name: "x" });
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe("backup", () => {
  test("export has no passwords and round-trips through normalizeBackup", () => {
    let d = upsertConnection(emptyAppData(), conn("a"));
    d = addItem(d, "queries", "a", query("q"));
    d = addItem(d, "queries", GLOBAL_SCOPE, query("g"));
    d = addItem(d, "results", GLOBAL_SCOPE, {
      id: "r",
      name: "r",
      query: "select 1",
      columns: [{ name: "x", type: "number" }],
      rows: [["1"], [null]],
      truncated: false,
    });
    const file = JSON.parse(JSON.stringify(toBackupFile(d)));
    expect(JSON.stringify(file)).not.toContain("password");
    expect(file.globalQueries).toHaveLength(1);

    const backup = normalizeBackup(file)!;
    expect(backup.connections).toEqual(d.connections);
    expect(backup.queries.a).toEqual(d.queries.a);
    expect(backup.queries[GLOBAL_SCOPE]).toEqual(d.queries[GLOBAL_SCOPE]);
    expect(backup.results[GLOBAL_SCOPE]).toEqual(d.results[GLOBAL_SCOPE]);
  });

  test("passwords are only exported when asked for, and the importer hands them back", () => {
    const d = upsertConnection(upsertConnection(emptyAppData(), conn("a")), conn("b"));
    expect(JSON.stringify(toBackupFile(d))).not.toContain("password");

    const file = JSON.parse(JSON.stringify(toBackupFile(d, { a: "s3cret" })));
    expect(file.connections[0].password).toBe("s3cret");
    expect("password" in file.connections[1]).toBe(false);

    const backup = normalizeBackup(file)!;
    expect(backup.legacyPasswords).toEqual({ a: "s3cret" });
    expect(JSON.stringify(backup.connections)).not.toContain("s3cret"); // never kept on the connection itself
  });

  test("merge adds new items, replaces same ids and never deletes existing data", () => {
    let d = upsertConnection(emptyAppData(), conn("a"));
    d = addItem(d, "queries", "a", query("mine"));
    const merged = mergeBackup(d, {
      connections: [{ ...conn("a"), name: "from file" }, conn("b")],
      legacyPasswords: {},
      queries: { a: [query("theirs")], b: [query("b1")] },
      results: {},
    });
    expect(merged.connections.map((c) => c.name)).toEqual(["from file", "b"]);
    expect(merged.queries.a.map((q) => q.id)).toEqual(["mine", "theirs"]);
    expect(merged.queries.b).toHaveLength(1);
    expect(merged.activeConnectionId).toBe("a");
    expect(d.connections[0].name).toBe("a");
  });
});
