import { test, expect, describe } from "bun:test";
import {
  normalizeBackup,
  normalizeConnection,
  normalizeQueriesByScope,
  normalizeResultsByScope,
  normalizeSavedQuery,
  normalizeSavedResult,
  readLegacyLocalStorage,
} from "./normalize";
import { GLOBAL_SCOPE, type Connection, type SslMode } from "../types/app";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const fullConn: Connection = {
  id: "c1",
  name: "Prod",
  host: "db.example.com",
  port: "5432",
  username: "u",
  database: "d",
  db_type: "postgres",
  ssl_mode: "verify",
  read_only: true,
  timeout_secs: 30,
  env: "",
};

describe("normalizeConnection", () => {
  test("non-objects return null", () => {
    for (const v of [null, undefined, 1, "x", true, [], [1]]) expect(normalizeConnection(v)).toBeNull();
  });

  test("full valid connection passes through", () => {
    expect(normalizeConnection(fullConn)).toEqual({ connection: fullConn, legacyPassword: null });
  });

  test("empty object gets safe defaults", () => {
    const r = normalizeConnection({});
    expect(r).not.toBeNull();
    const c = r!.connection;
    expect(c.id).toMatch(UUID);
    expect(c).toMatchObject({
      name: "",
      host: "",
      port: "",
      username: "",
      database: "",
      db_type: "postgres",
      ssl_mode: "prefer",
      read_only: false,
      timeout_secs: 0,
      env: "",
    });
    expect(r!.legacyPassword).toBeNull();
  });

  test("missing name and host do not crash and are strings", () => {
    const { connection } = normalizeConnection({ id: "x", port: 5432, db_type: "clickhouse" })!;
    expect(connection.name).toBe("");
    expect(connection.host).toBe("");
    expect(() => connection.name.trim() + connection.host.trim()).not.toThrow();
  });

  test("non-string fields become empty strings", () => {
    const { connection } = normalizeConnection({
      id: "x",
      name: 5,
      host: null,
      username: {},
      database: ["a"],
    })!;
    expect(connection).toMatchObject({ name: "", host: "", username: "", database: "" });
  });

  test("empty / blank / non-string id is regenerated, valid id kept", () => {
    expect(normalizeConnection({ id: "" })!.connection.id).toMatch(UUID);
    expect(normalizeConnection({ id: "   " })!.connection.id).toMatch(UUID);
    expect(normalizeConnection({ id: 7 })!.connection.id).toMatch(UUID);
    expect(normalizeConnection({ id: "keep-me" })!.connection.id).toBe("keep-me");
  });

  test("dangerous ids are regenerated", () => {
    expect(normalizeConnection({ id: "__proto__" })!.connection.id).toMatch(UUID);
  });

  test("port accepts numbers and strings", () => {
    expect(normalizeConnection({ port: 5432 })!.connection.port).toBe("5432");
    expect(normalizeConnection({ port: " 8123 " })!.connection.port).toBe("8123");
    expect(normalizeConnection({ port: NaN })!.connection.port).toBe("");
    expect(normalizeConnection({ port: null })!.connection.port).toBe("");
    expect(normalizeConnection({ port: {} })!.connection.port).toBe("");
  });

  test("trims host, port, username, database but not name", () => {
    const { connection } = normalizeConnection({
      name: "  My DB ",
      host: " h ",
      port: " 1 ",
      username: " u ",
      database: " d ",
    })!;
    expect(connection).toMatchObject({ name: "  My DB ", host: "h", port: "1", username: "u", database: "d" });
  });

  test("invalid db_type defaults to postgres", () => {
    expect(normalizeConnection({ db_type: "mysql" })!.connection.db_type).toBe("postgres");
    expect(normalizeConnection({ db_type: 3 })!.connection.db_type).toBe("postgres");
    expect(normalizeConnection({ db_type: "clickhouse" })!.connection.db_type).toBe("clickhouse");
  });

  describe("ssl_mode", () => {
    test("valid values are kept", () => {
      for (const m of ["disable", "prefer", "require", "verify"] as SslMode[]) {
        expect(normalizeConnection({ db_type: "postgres", ssl_mode: m })!.connection.ssl_mode).toBe(m);
        expect(normalizeConnection({ db_type: "clickhouse", ssl_mode: m })!.connection.ssl_mode).toBe(m);
      }
    });

    test("legacy postgres defaults to prefer", () => {
      expect(normalizeConnection({ db_type: "postgres" })!.connection.ssl_mode).toBe("prefer");
      expect(normalizeConnection({ db_type: "postgres", ssl_mode: "bogus" })!.connection.ssl_mode).toBe("prefer");
    });

    test("legacy clickhouse derives from host scheme", () => {
      expect(normalizeConnection({ db_type: "clickhouse", host: "https://ch.io" })!.connection.ssl_mode).toBe("verify");
      expect(normalizeConnection({ db_type: "clickhouse", host: "HTTPS://ch.io" })!.connection.ssl_mode).toBe("verify");
      expect(normalizeConnection({ db_type: "clickhouse", host: "http://ch.io" })!.connection.ssl_mode).toBe("disable");
      expect(normalizeConnection({ db_type: "clickhouse", host: "ch.io" })!.connection.ssl_mode).toBe("disable");
      expect(normalizeConnection({ db_type: "clickhouse" })!.connection.ssl_mode).toBe("disable");
    });

    test("explicit ssl_mode wins over host scheme", () => {
      expect(normalizeConnection({ db_type: "clickhouse", host: "https://x", ssl_mode: "require" })!.connection.ssl_mode).toBe(
        "require",
      );
    });
  });

  describe("clickhouse host", () => {
    test("strips scheme and trailing slashes", () => {
      expect(normalizeConnection({ db_type: "clickhouse", host: "https://ch.io/" })!.connection.host).toBe("ch.io");
      expect(normalizeConnection({ db_type: "clickhouse", host: "http://ch.io" })!.connection.host).toBe("ch.io");
      expect(normalizeConnection({ db_type: "clickhouse", host: "  https://ch.io//  " })!.connection.host).toBe("ch.io");
      expect(normalizeConnection({ db_type: "clickhouse", host: "ch.io/" })!.connection.host).toBe("ch.io");
    });

    test("is stripped even when ssl_mode is already set", () => {
      expect(
        normalizeConnection({ db_type: "clickhouse", host: "https://ch.io", ssl_mode: "verify" })!.connection.host,
      ).toBe("ch.io");
    });

    test("postgres host is left alone", () => {
      expect(normalizeConnection({ db_type: "postgres", host: "https://odd/" })!.connection.host).toBe("https://odd/");
    });
  });

  test("read_only: boolean kept, default false", () => {
    expect(normalizeConnection({ read_only: true })!.connection.read_only).toBe(true);
    expect(normalizeConnection({ read_only: false })!.connection.read_only).toBe(false);
    expect(normalizeConnection({})!.connection.read_only).toBe(false);
    expect(normalizeConnection({ read_only: "true" })!.connection.read_only).toBe(false);
  });

  test("env: one of the known values, anything else is none", () => {
    const e = (v: unknown) => normalizeConnection({ env: v })!.connection.env;
    expect(e("prod")).toBe("prod");
    expect(e("staging")).toBe("staging");
    expect(e("local")).toBe("local");
    expect(e("production")).toBe("");
    expect(e(undefined)).toBe("");
    expect(e(5)).toBe("");
  });

  test("timeout_secs: finite non-negative integer else 0", () => {
    const t = (v: unknown) => normalizeConnection({ timeout_secs: v })!.connection.timeout_secs;
    expect(t(0)).toBe(0);
    expect(t(45)).toBe(45);
    expect(t(-1)).toBe(0);
    expect(t(1.5)).toBe(0);
    expect(t(NaN)).toBe(0);
    expect(t(Infinity)).toBe(0);
    expect(t("30")).toBe(0);
    expect(t(null)).toBe(0);
  });

  test("legacy password is extracted and removed from the connection", () => {
    const r = normalizeConnection({ ...fullConn, password: "secret" })!;
    expect(r.legacyPassword).toBe("secret");
    expect("password" in r.connection).toBe(false);
  });

  test("empty / non-string password gives null", () => {
    expect(normalizeConnection({ password: "" })!.legacyPassword).toBeNull();
    expect(normalizeConnection({ password: 123 })!.legacyPassword).toBeNull();
    expect(normalizeConnection({ password: null })!.legacyPassword).toBeNull();
  });

  test("unknown keys such as active are dropped", () => {
    const { connection } = normalizeConnection({ ...fullConn, active: true, extra: 1, password: "p" })!;
    expect(Object.keys(connection).sort()).toEqual(Object.keys(fullConn).sort());
  });

  test("password is not trimmed", () => {
    expect(normalizeConnection({ password: " p " })!.legacyPassword).toBe(" p ");
  });
});

describe("normalizeSavedQuery", () => {
  test("non-objects return null", () => {
    for (const v of [null, undefined, "q", 1, [], ["a"]]) expect(normalizeSavedQuery(v)).toBeNull();
  });

  test("valid query", () => {
    expect(normalizeSavedQuery({ id: "q1", name: "n", query: "select 1" })).toEqual({
      id: "q1",
      name: "n",
      query: "select 1",
    });
  });

  test("defaults and id generation", () => {
    const q = normalizeSavedQuery({})!;
    expect(q.id).toMatch(UUID);
    expect(q.name).toBe("");
    expect(q.query).toBe("");
    expect(normalizeSavedQuery({ id: "", name: 1, query: null })).toMatchObject({ name: "", query: "" });
  });

  test("drops extra keys such as active", () => {
    const q = normalizeSavedQuery({ id: "q", name: "n", query: "s", active: true, foo: 1 })!;
    expect(Object.keys(q).sort()).toEqual(["id", "name", "query"]);
  });
});

describe("normalizeSavedResult", () => {
  test("non-objects return null", () => {
    for (const v of [null, undefined, "r", 1, [], [{}]]) expect(normalizeSavedResult(v)).toBeNull();
  });

  test("object with neither columns nor records returns null", () => {
    expect(normalizeSavedResult({ id: "r", name: "n", query: "q" })).toBeNull();
    expect(normalizeSavedResult({ records: "nope" })).toBeNull();
  });

  describe("new shape", () => {
    test("valid result passes through", () => {
      const r = {
        id: "r1",
        name: "n",
        query: "select",
        columns: [
          { name: "a", type: "number" },
          { name: "b", type: "string" },
        ],
        rows: [
          ["1", "x"],
          ["2", null],
        ],
        truncated: true,
      };
      expect(normalizeSavedResult(r)).toEqual(r);
    });

    test("defaults", () => {
      const r = normalizeSavedResult({ columns: [] })!;
      expect(r.id).toMatch(UUID);
      expect(r).toMatchObject({ name: "", query: "", columns: [], rows: [], truncated: false });
    });

    test("pads and truncates rows to column count", () => {
      const r = normalizeSavedResult({
        columns: [
          { name: "a", type: "string" },
          { name: "b", type: "string" },
        ],
        rows: [["1"], ["1", "2", "3"], []],
      })!;
      expect(r.rows).toEqual([
        ["1", null],
        ["1", "2"],
        [null, null],
      ]);
    });

    test("garbage rows are skipped", () => {
      const r = normalizeSavedResult({
        columns: [{ name: "a", type: "string" }],
        rows: [["1"], null, "x", 5, { a: 1 }, ["2"]],
      })!;
      expect(r.rows).toEqual([["1"], ["2"]]);
    });

    test("cells are coerced defensively", () => {
      const r = normalizeSavedResult({
        columns: [{ name: "a", type: "x" }],
        rows: [[1], [true], [undefined], [{ k: 1 }], [[1, 2]], [null]],
      })!;
      expect(r.rows).toEqual([["1"], ["true"], [null], ['{"k":1}'], ["[1,2]"], [null]]);
    });

    test("malformed columns are repaired", () => {
      const r = normalizeSavedResult({ columns: [{ name: "a" }, "b", null, { type: 3 }], rows: [] })!;
      expect(r.columns).toEqual([
        { name: "a", type: "string" },
        { name: "b", type: "string" },
        { name: "", type: "string" },
        { name: "", type: "string" },
      ]);
    });

    test("rows not an array gives empty rows", () => {
      expect(normalizeSavedResult({ columns: [{ name: "a", type: "string" }], rows: "x" })!.rows).toEqual([]);
    });

    test("truncated must be exactly true", () => {
      expect(normalizeSavedResult({ columns: [], truncated: "yes" })!.truncated).toBe(false);
      expect(normalizeSavedResult({ columns: [], truncated: true })!.truncated).toBe(true);
    });

    test("extra keys are dropped", () => {
      const r = normalizeSavedResult({ columns: [], rows: [], active: true, records: [{ a: 1 }] })!;
      expect(Object.keys(r).sort()).toEqual(["columns", "id", "name", "query", "rows", "truncated"]);
      expect(r.columns).toEqual([]);
    });
  });

  describe("legacy shape", () => {
    test("converts records", () => {
      const r = normalizeSavedResult({
        id: "r1",
        name: "n",
        query: "q",
        records: [
          { id: 1, name: "a", ok: true },
          { id: 2, name: "b", ok: false },
        ],
        active: true,
      })!;
      expect(r.columns).toEqual([
        { name: "id", type: "number" },
        { name: "name", type: "string" },
        { name: "ok", type: "bool" },
      ]);
      expect(r.rows).toEqual([
        ["1", "a", "true"],
        ["2", "b", "false"],
      ]);
      expect(r.truncated).toBe(false);
      expect(r.id).toBe("r1");
      expect("active" in r).toBe(false);
      expect("records" in r).toBe(false);
    });

    test("empty records", () => {
      const r = normalizeSavedResult({ records: [] })!;
      expect(r.columns).toEqual([]);
      expect(r.rows).toEqual([]);
    });

    test("null and undefined cells become null; null does not affect type", () => {
      const r = normalizeSavedResult({
        records: [{ a: 1, b: null }, { a: null, b: "x" }, { a: 3 }],
      })!;
      expect(r.columns).toEqual([
        { name: "a", type: "number" },
        { name: "b", type: "string" },
      ]);
      expect(r.rows).toEqual([
        ["1", null],
        [null, "x"],
        ["3", null],
      ]);
    });

    test("all-null column is a string column", () => {
      const r = normalizeSavedResult({ records: [{ a: null }, { a: null }] })!;
      expect(r.columns).toEqual([{ name: "a", type: "string" }]);
      expect(r.rows).toEqual([[null], [null]]);
    });

    test("object and array cells are JSON-stringified", () => {
      const r = normalizeSavedResult({
        records: [{ j: { a: [1, 2] }, arr: [1, "x", null], n: null }],
      })!;
      expect(r.rows).toEqual([['{"a":[1,2]}', '[1,"x",null]', null]]);
      expect(r.columns.map((c) => c.type)).toEqual(["string", "string", "string"]);
    });

    test("mixed value types give string; strings kept as is", () => {
      const r = normalizeSavedResult({ records: [{ a: 1 }, { a: "2" }, { a: true }] })!;
      expect(r.columns).toEqual([{ name: "a", type: "string" }]);
      expect(r.rows).toEqual([["1"], ["2"], ["true"]]);
    });

    test("columns are the union of keys in order of first appearance", () => {
      const r = normalizeSavedResult({ records: [{ b: 1, a: 2 }, { c: 3, a: 4 }, { d: 5 }] })!;
      expect(r.columns.map((c) => c.name)).toEqual(["b", "a", "c", "d"]);
      expect(r.rows).toEqual([
        ["1", "2", null, null],
        [null, "4", "3", null],
        [null, null, null, "5"],
      ]);
    });

    test("garbage records are skipped", () => {
      const r = normalizeSavedResult({ records: [null, 1, "x", [1], { a: 1 }, undefined] })!;
      expect(r.rows).toEqual([["1"]]);
    });

    test("prototype-ish keys in records are plain columns", () => {
      const records = JSON.parse('[{"__proto__": 1, "constructor": "c"}, {"a": 2}]');
      const r = normalizeSavedResult({ records })!;
      expect(r.columns.map((c) => c.name)).toEqual(["__proto__", "constructor", "a"]);
      expect(r.rows).toEqual([
        ["1", "c", null],
        [null, null, "2"],
      ]);
    });

    test("a record lacking __proto__ does not inherit Object.prototype", () => {
      const records = JSON.parse('[{"__proto__": 1}, {"a": 2}]');
      const r = normalizeSavedResult({ records })!;
      expect(r.rows[1]).toEqual([null, "2"]);
    });

    test("numbers: negatives, floats and zero", () => {
      const r = normalizeSavedResult({ records: [{ a: 0 }, { a: -1.5 }] })!;
      expect(r.rows).toEqual([["0"], ["-1.5"]]);
      expect(r.columns[0]!.type).toBe("number");
    });

    test("new shape wins when both are present", () => {
      const r = normalizeSavedResult({ columns: [{ name: "x", type: "string" }], rows: [["1"]], records: [{ y: 1 }] })!;
      expect(r.columns[0]!.name).toBe("x");
    });
  });
});

describe("by-scope normalisers", () => {
  test("non-objects give empty record", () => {
    for (const v of [null, undefined, [], "x", 1]) {
      expect(normalizeQueriesByScope(v)).toEqual({});
      expect(normalizeResultsByScope(v)).toEqual({});
    }
  });

  test("queries: keeps valid, skips invalid items and non-array scopes", () => {
    const out = normalizeQueriesByScope({
      c1: [{ id: "a", name: "n", query: "q", active: true }, null, 5, { id: "b" }],
      c2: "nope",
      c3: { id: "x" },
      c4: [],
    });
    expect(Object.keys(out).sort()).toEqual(["c1", "c4"]);
    expect(out.c1).toEqual([
      { id: "a", name: "n", query: "q" },
      { id: "b", name: "", query: "" },
    ]);
    expect(out.c4).toEqual([]);
  });

  test("results: converts legacy and skips invalid", () => {
    const out = normalizeResultsByScope({
      c1: [{ id: "r", name: "n", query: "q", records: [{ a: 1 }] }, { nothing: true }, null],
      c2: 5,
    });
    expect(Object.keys(out)).toEqual(["c1"]);
    expect(out.c1).toHaveLength(1);
    expect(out.c1![0]!.rows).toEqual([["1"]]);
  });

  test("prototype pollution keys are skipped", () => {
    const raw = JSON.parse(
      '{"__proto__": [{"id":"p","name":"n","query":"q"}], "constructor": [{"id":"c"}], "prototype": [], "ok": [{"id":"o"}]}',
    );
    const q = normalizeQueriesByScope(raw);
    const r = normalizeResultsByScope(JSON.parse('{"__proto__": [{"columns": []}], "ok": [{"columns": []}]}'));
    expect(Object.keys(q)).toEqual(["ok"]);
    expect(Object.keys(r)).toEqual(["ok"]);
    expect(Object.getPrototypeOf(q)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).id).toBeUndefined();
    expect(Array.isArray((q as Record<string, unknown>)["__proto__"])).toBe(false);
  });
});

describe("normalizeBackup", () => {
  test("unrecognisable input returns null", () => {
    for (const v of [null, undefined, 1, "x", true, {}, { queries: {} }, { connections: "x" }, { foo: [] }]) {
      expect(normalizeBackup(v)).toBeNull();
    }
  });

  test("current format", () => {
    const b = normalizeBackup({
      connections: [{ ...fullConn, password: "pw" }, { ...fullConn, id: "c2", name: "Two" }],
      queries: { c1: [{ id: "q1", name: "n", query: "s" }], c2: [] },
      results: { c1: [{ id: "r1", name: "n", query: "q", columns: [{ name: "a", type: "string" }], rows: [["1"]] }] },
      globalQueries: [{ id: "gq", name: "g", query: "select" }],
      globalResults: [{ id: "gr", name: "g", query: "q", records: [{ a: 1 }] }],
    })!;
    expect(b.connections.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect("password" in b.connections[0]!).toBe(false);
    expect(b.legacyPasswords).toEqual({ c1: "pw" });
    expect(Object.keys(b.queries).sort()).toEqual([GLOBAL_SCOPE, "c1", "c2"].sort());
    expect(b.queries.c1).toHaveLength(1);
    expect(b.queries[GLOBAL_SCOPE]).toEqual([{ id: "gq", name: "g", query: "select" }]);
    expect(Object.keys(b.results).sort()).toEqual([GLOBAL_SCOPE, "c1"].sort());
    expect(b.results[GLOBAL_SCOPE]![0]!.rows).toEqual([["1"]]);
  });

  test("scopes referring to unknown connections are dropped", () => {
    const b = normalizeBackup({
      connections: [fullConn],
      queries: { c1: [{ id: "a" }], ghost: [{ id: "b" }] },
      results: { ghost: [{ columns: [] }] },
    })!;
    expect(Object.keys(b.queries)).toEqual(["c1"]);
    expect(b.results).toEqual({});
  });

  test("oldest format: bare array of connections", () => {
    const b = normalizeBackup([{ ...fullConn, password: "pw" }, { name: "second" }])!;
    expect(b.connections).toHaveLength(2);
    expect(b.connections[1]!.id).toMatch(UUID);
    expect(b.connections[1]!.name).toBe("second");
    expect(b.legacyPasswords).toEqual({ c1: "pw" });
    expect(b.queries).toEqual({});
    expect(b.results).toEqual({});
  });

  test("empty array is a valid (empty) backup", () => {
    expect(normalizeBackup([])).toEqual({ connections: [], legacyPasswords: {}, queries: {}, results: {} });
  });

  test("connections without queries / results", () => {
    const b = normalizeBackup({ connections: [fullConn] })!;
    expect(b.connections).toHaveLength(1);
    expect(b.queries).toEqual({});
    expect(b.results).toEqual({});
  });

  test("only globals (no connections array)", () => {
    const b = normalizeBackup({ globalQueries: [{ id: "g", name: "n", query: "q" }] })!;
    expect(b.connections).toEqual([]);
    expect(b.queries).toEqual({ [GLOBAL_SCOPE]: [{ id: "g", name: "n", query: "q" }] });
  });

  test("empty globals do not create a global scope", () => {
    const b = normalizeBackup({ connections: [], globalQueries: [], globalResults: [] })!;
    expect(b.queries).toEqual({});
    expect(b.results).toEqual({});
  });

  test("garbage connections and items are skipped", () => {
    const b = normalizeBackup({
      connections: [null, 3, "x", fullConn, []],
      queries: { c1: [null, { id: "ok", name: "n", query: "q" }] },
      globalQueries: [null, "x", { id: "g" }],
    })!;
    expect(b.connections).toHaveLength(1);
    expect(b.queries.c1).toEqual([{ id: "ok", name: "n", query: "q" }]);
    expect(b.queries[GLOBAL_SCOPE]).toHaveLength(1);
  });

  test("a 'global' key inside queries is merged with globalQueries", () => {
    const b = normalizeBackup({
      connections: [],
      queries: { [GLOBAL_SCOPE]: [{ id: "a" }] },
      globalQueries: [{ id: "b" }],
    })!;
    expect(b.queries[GLOBAL_SCOPE]!.map((q) => q.id)).toEqual(["a", "b"]);
  });

  test("duplicate connection ids are made unique", () => {
    const b = normalizeBackup({ connections: [{ id: "d", password: "1" }, { id: "d", password: "2" }] })!;
    const ids = b.connections.map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe("d");
    expect(b.legacyPasswords[ids[0]!]).toBe("1");
    expect(b.legacyPasswords[ids[1]!]).toBe("2");
  });

  test("prototype pollution via scopes and ids", () => {
    const raw = JSON.parse(
      '{"connections":[{"id":"__proto__","name":"x"}],"queries":{"__proto__":[{"id":"a"}],"constructor":[{"id":"b"}]},"results":{"__proto__":[{"columns":[]}]}}',
    );
    const b = normalizeBackup(raw)!;
    expect(b.connections[0]!.id).toMatch(UUID);
    expect(b.queries).toEqual({});
    expect(b.results).toEqual({});
    expect(({} as Record<string, unknown>).id).toBeUndefined();
  });

  test("legacy-format full end to end", () => {
    const b = normalizeBackup({
      connections: [{ id: "ch", db_type: "clickhouse", host: "https://x.io/", port: 8443, password: "p", active: true }],
      queries: { ch: [{ id: "q", name: "n", query: "s", active: true }] },
      results: { ch: [{ id: "r", name: "n", query: "q", records: [{ a: null, b: { c: 1 } }] }] },
    })!;
    expect(b.connections[0]).toEqual({
      id: "ch",
      name: "",
      host: "x.io",
      port: "8443",
      username: "",
      database: "",
      db_type: "clickhouse",
      ssl_mode: "verify",
      read_only: false,
      timeout_secs: 0,
      env: "",
    });
    expect(b.results.ch![0]!.rows).toEqual([[null, '{"c":1}']]);
  });
});

describe("readLegacyLocalStorage", () => {
  const store = (data: Record<string, unknown>) => (key: string) => {
    if (!(key in data)) return null;
    const v = data[key];
    return typeof v === "string" ? v : JSON.stringify(v);
  };
  const raw = (data: Record<string, string>) => (key: string) => (key in data ? data[key]! : null);

  test("returns null when no keys exist", () => {
    expect(readLegacyLocalStorage(() => null)).toBeNull();
    expect(readLegacyLocalStorage(store({ unrelated: 1 }))).toBeNull();
  });

  test("returns a result when a key exists even if corrupt", () => {
    const r = readLegacyLocalStorage(raw({ connections: "{not json" }))!;
    expect(r).toEqual({ connections: [], legacyPasswords: {}, activeConnectionId: null, queries: {}, results: {} });
  });

  test("get throwing is treated as missing", () => {
    expect(
      readLegacyLocalStorage(() => {
        throw new Error("denied");
      }),
    ).toBeNull();
  });

  test("full old layout", () => {
    const r = readLegacyLocalStorage(
      store({
        connections: [
          { id: "a", name: "A", host: "h", port: "5432", username: "u", password: "pa", database: "d", db_type: "postgres" },
          { id: "b", name: "B", host: "https://ch/", port: "8443", username: "u", password: "", database: "", db_type: "clickhouse", active: true },
        ],
        savedQueries: { a: [{ id: "q1", name: "n", query: "s", active: true }], b: [] },
        savedResults: { a: [{ id: "r1", name: "n", query: "q", records: [{ x: 1 }], active: true }] },
        globalSavedQueries: [{ id: "gq", name: "g", query: "s" }],
        globalSavedResults: [{ id: "gr", name: "g", query: "q", records: [{ y: "z" }] }],
      }),
    )!;
    expect(r.connections.map((c) => c.id)).toEqual(["a", "b"]);
    expect(r.activeConnectionId).toBe("b");
    expect(r.legacyPasswords).toEqual({ a: "pa" });
    expect(r.connections[0]).toMatchObject({ ssl_mode: "prefer", read_only: false, timeout_secs: 0 });
    expect(r.connections[1]).toMatchObject({ host: "ch", ssl_mode: "verify" });
    expect(r.connections.every((c) => !("active" in c) && !("password" in c))).toBe(true);
    expect(r.queries.a).toEqual([{ id: "q1", name: "n", query: "s" }]);
    expect(r.queries.b).toEqual([]);
    expect(r.queries[GLOBAL_SCOPE]).toEqual([{ id: "gq", name: "g", query: "s" }]);
    expect(r.results.a![0]!.rows).toEqual([["1"]]);
    expect(r.results[GLOBAL_SCOPE]![0]!.columns).toEqual([{ name: "y", type: "string" }]);
  });

  test("active falls back to the first connection", () => {
    const r = readLegacyLocalStorage(store({ connections: [{ id: "a" }, { id: "b" }] }))!;
    expect(r.activeConnectionId).toBe("a");
  });

  test("first active:true wins", () => {
    const r = readLegacyLocalStorage(store({ connections: [{ id: "a" }, { id: "b", active: true }, { id: "c", active: true }] }))!;
    expect(r.activeConnectionId).toBe("b");
  });

  test("active refers to the normalised id when the id was missing", () => {
    const r = readLegacyLocalStorage(store({ connections: [{ id: "a" }, { name: "noid", active: true }] }))!;
    expect(r.activeConnectionId).toBe(r.connections[1]!.id);
    expect(r.activeConnectionId).toMatch(UUID);
  });

  test("garbage connection entries are skipped and active index stays aligned", () => {
    const r = readLegacyLocalStorage(store({ connections: [null, { id: "a" }, 5, { id: "b", active: true }] }))!;
    expect(r.connections.map((c) => c.id)).toEqual(["a", "b"]);
    expect(r.activeConnectionId).toBe("b");
  });

  test("no connections -> active null", () => {
    const r = readLegacyLocalStorage(store({ connections: [] }))!;
    expect(r.activeConnectionId).toBeNull();
  });

  test("connections that are not an array are ignored", () => {
    const r = readLegacyLocalStorage(store({ connections: { a: 1 } }))!;
    expect(r.connections).toEqual([]);
  });

  test("oldest layout: bare savedQueries array belongs to the first connection", () => {
    const r = readLegacyLocalStorage(
      store({
        connections: [{ id: "first" }, { id: "second" }],
        savedQueries: [{ id: "q", name: "n", query: "s" }],
        savedResults: [{ id: "r", records: [{ a: 1 }] }],
      }),
    )!;
    expect(Object.keys(r.queries)).toEqual(["first"]);
    expect(r.queries.first).toEqual([{ id: "q", name: "n", query: "s" }]);
    expect(Object.keys(r.results)).toEqual(["first"]);
  });

  test("bare savedQueries array without connections is dropped", () => {
    const r = readLegacyLocalStorage(store({ savedQueries: [{ id: "q" }] }))!;
    expect(r.queries).toEqual({});
  });

  test("bare array scope with a dangerous first id uses a safe generated id", () => {
    const r = readLegacyLocalStorage(
      raw({ connections: '[{"id":"constructor"}]', savedQueries: '[{"id":"q"}]' }),
    )!;
    expect(r.connections[0]!.id).toMatch(UUID);
    expect(r.queries[r.connections[0]!.id]).toHaveLength(1);
  });

  test("corrupt JSON in any key is treated as empty", () => {
    const r = readLegacyLocalStorage(
      raw({
        connections: JSON.stringify([{ id: "a" }]),
        savedQueries: "{oops",
        savedResults: "undefined",
        globalSavedQueries: "[1,",
        globalSavedResults: "",
      }),
    )!;
    expect(r.connections).toHaveLength(1);
    expect(r.queries).toEqual({});
    expect(r.results).toEqual({});
  });

  test("JSON of the wrong type is treated as empty", () => {
    const r = readLegacyLocalStorage(
      store({ connections: "null", savedQueries: "5", savedResults: '"s"', globalSavedQueries: "{}", globalSavedResults: "null" }),
    )!;
    expect(r).toEqual({ connections: [], legacyPasswords: {}, activeConnectionId: null, queries: {}, results: {} });
  });

  test("only global keys present", () => {
    const r = readLegacyLocalStorage(store({ globalSavedQueries: [{ id: "g", name: "n", query: "q" }] }))!;
    expect(r.connections).toEqual([]);
    expect(r.queries).toEqual({ [GLOBAL_SCOPE]: [{ id: "g", name: "n", query: "q" }] });
  });

  test("prototype pollution keys in savedQueries / savedResults", () => {
    const r = readLegacyLocalStorage(
      raw({
        connections: '[{"id":"a"}]',
        savedQueries: '{"__proto__":[{"id":"x"}],"a":[{"id":"y"}]}',
        savedResults: '{"__proto__":[{"columns":[]}],"constructor":[]}',
      }),
    )!;
    expect(Object.keys(r.queries)).toEqual(["a"]);
    expect(r.results).toEqual({});
    expect(({} as Record<string, unknown>).id).toBeUndefined();
  });

  test("scope keys in saved* objects that match no connection are kept", () => {
    const r = readLegacyLocalStorage(store({ connections: [{ id: "a" }], savedQueries: { zzz: [{ id: "q" }] } }))!;
    expect(Object.keys(r.queries)).toEqual(["zzz"]);
  });
});
