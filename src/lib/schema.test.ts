import { describe, expect, test } from "bun:test";
import type { StatementOutcome } from "../types/app";
import { buildSchema, closestName, editDistance, formatBytes, formatCount, parseAliases, parseMissingIdentifier, qualifiedName, quoteIdent, schemaQueries } from "./schema";

const outcome = (rows: (string | null)[][]): StatementOutcome => ({ sql: "", elapsed_ms: 1, error: null, result: { columns: [], rows, truncated: false, message: null } });

describe("buildSchema (postgres)", () => {
  const schema = buildSchema("postgres", [
    outcome([["public", "customers", "r", "14", "49152"], ["public", "active", "v", "-1", null], ["billing", "invoices", "p", "88000", "1000"]]),
    outcome([["public", "customers", "id", "bigint", "false"], ["public", "customers", "name", "text", "true"], ["public", "active", "id", "bigint", "true"], ["billing", "invoices", "customer_id", "bigint", "false"]]),
    outcome([["public", "customers", "id", "p"], ["billing", "invoices", "customer_id", "f"]]),
    outcome([["public", "customer_ltv", "customer_id bigint", "numeric"]]),
  ], 5);
  test("tables, kinds, estimates", () => {
    expect(schema.tables.map((t) => [t.schema, t.name, t.kind, t.rows])).toEqual([["public", "customers", "table", 14], ["public", "active", "view", null], ["billing", "invoices", "table", 88000]]);
  });
  test("columns with keys and nullability", () => {
    const customers = schema.tables[0];
    expect(customers.columns).toEqual([{ name: "id", type: "bigint", nullable: false, key: "pk" }, { name: "name", type: "text", nullable: true, key: "" }]);
    expect(schema.tables[2].columns[0].key).toBe("fk");
  });
  test("schemas put public first; functions are read", () => {
    expect(schema.schemas).toEqual(["public", "billing"]);
    expect(schema.functions).toEqual([{ schema: "public", name: "customer_ltv", args: "customer_id bigint", returns: "numeric" }]);
  });
});

describe("buildSchema (clickhouse)", () => {
  test("views, nullable and primary key", () => {
    const s = buildSchema("clickhouse", [
      outcome([["analytics", "events", "MergeTree", "1000", "5000"], ["analytics", "v", "MaterializedView", null, null]]),
      outcome([["analytics", "events", "ts", "DateTime", "1"], ["analytics", "events", "user", "Nullable(String)", "0"]]),
    ]);
    expect(s.tables.map((t) => t.kind)).toEqual(["table", "matview"]);
    expect(s.tables[0].columns).toEqual([{ name: "ts", type: "DateTime", nullable: false, key: "pk" }, { name: "user", type: "Nullable(String)", nullable: true, key: "" }]);
    expect(s.functions).toEqual([]);
  });
});

test("one catalog query per statement", () => {
  for (const q of [...schemaQueries("postgres"), ...schemaQueries("clickhouse")]) expect(q.includes(";")).toBe(false);
});

describe("formatting", () => {
  test("counts and bytes", () => {
    expect(formatCount(14)).toBe("14");
    expect(formatCount(1_200_000)).toBe("1.2M");
    expect(formatCount(null)).toBe("");
    expect(formatBytes(49152)).toBe("48 kB");
    expect(formatBytes(312 * 2 ** 20)).toBe("312 MB");
  });
  test("identifier quoting and qualification", () => {
    expect(quoteIdent("customers", "postgres")).toBe("customers");
    expect(quoteIdent("Order Items", "postgres")).toBe('"Order Items"');
    expect(quoteIdent("order", "postgres")).toBe('"order"');
    expect(quoteIdent("My Table", "clickhouse")).toBe("`My Table`");
    expect(qualifiedName({ schema: "public", name: "t" }, "postgres", "public")).toBe("t");
    expect(qualifiedName({ schema: "billing", name: "t" }, "postgres", "public")).toBe("billing.t");
  });
});

describe("typo helpers", () => {
  test("editDistance", () => {
    expect(editDistance("create_at", "created_at")).toBe(1);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("same", "same")).toBe(0);
  });
  test("closestName only suggests plausible typos", () => {
    const cols = ["id", "name", "created_at", "plan"];
    expect(closestName("create_at", cols)).toBe("created_at");
    expect(closestName("Name", cols)).toBeNull(); // identical ignoring case is not a typo
    expect(closestName("totally_different", cols)).toBeNull();
    expect(closestName("nme", cols)).toBe("name");
  });
  test("parseMissingIdentifier", () => {
    expect(parseMissingIdentifier('ERROR: column "create_at" does not exist')).toEqual({ kind: "column", name: "create_at" });
    expect(parseMissingIdentifier('ERROR: column c.nme does not exist')).toBeNull();
    expect(parseMissingIdentifier('ERROR: relation "custmers" does not exist')).toEqual({ kind: "table", name: "custmers" });
    expect(parseMissingIdentifier("Code: 47. DB::Exception: Unknown identifier 'nme' in scope")).toEqual({ kind: "column", name: "nme" });
    expect(parseMissingIdentifier("syntax error")).toBeNull();
  });
});

describe("parseAliases", () => {
  test("from / join with and without as", () => {
    const m = parseAliases("select c.name from customers c\njoin orders as o on o.customer_id = c.id\nleft join public.items i using (id) where 1=1");
    expect(m.get("c")).toBe("customers");
    expect(m.get("o")).toBe("orders");
    expect(m.get("i")).toBe("items");
    expect(m.get("customers")).toBe("customers");
  });
  test("keywords are not aliases", () => {
    const m = parseAliases("select * from customers where id = 1");
    expect(m.has("where")).toBe(false);
    expect(m.get("customers")).toBe("customers");
  });
});
