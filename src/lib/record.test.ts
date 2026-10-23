import { describe, expect, test } from "bun:test";
import type { ColumnMeta } from "../types/app";
import { embeddedJson, parseTimestamp, rowToInsert, rowToObject, typedValue } from "./record";

const col = (name: string, type: string): ColumnMeta => ({ name, type });

describe("typedValue", () => {
  test("keeps exactness", () => {
    expect(typedValue(col("id", "number"), "42")).toBe(42);
    expect(typedValue(col("id", "number"), "9007199254740993")).toBe("9007199254740993");
    expect(typedValue(col("p", "number"), "1.50")).toBe("1.50");
    expect(typedValue(col("a", "bool"), "true")).toBe(true);
    expect(typedValue(col("m", "json"), '{"a":1}')).toEqual({ a: 1 });
    expect(typedValue(col("m", "json"), "not json")).toBe("not json");
    expect(typedValue(col("t", "array"), "{a,b}")).toEqual(["a", "b"]);
    expect(typedValue(col("n", "string"), null)).toBeNull();
  });
});

describe("rowToObject", () => {
  test("duplicate column names do not overwrite each other", () => {
    expect(rowToObject([col("id", "number"), col("id", "number")], ["1", "2"])).toEqual({ id: 1, id_2: 2 });
  });
});

describe("rowToInsert", () => {
  test("quotes text, keeps numbers, handles null and booleans", () => {
    const sql = rowToInsert("customers", [col("id", "number"), col("name", "string"), col("note", "string"), col("active", "bool"), col("Mixed Case", "string")], ["1", "O'Neil", null, "true", "x"]);
    expect(sql).toBe(`insert into customers (id, name, note, active, "Mixed Case") values (1, 'O''Neil', NULL, TRUE, 'x');`);
  });
});

describe("rowToInsert for ClickHouse", () => {
  test("backslashes and quotes are escaped the ClickHouse way", () => {
    expect(rowToInsert("t", [col("a", "string")], ["a\\b'c"], "clickhouse")).toBe("insert into t (a) values ('a\\\\b\\'c');");
  });
});

describe("parseTimestamp", () => {
  test("common database formats", () => {
    expect(parseTimestamp("2026-09-02 09:14:22+00")).toBe(Date.UTC(2026, 8, 2, 9, 14, 22));
    expect(parseTimestamp("2026-09-02T09:14:22Z")).toBe(Date.UTC(2026, 8, 2, 9, 14, 22));
    expect(parseTimestamp("2026-09-02 09:14:22")).toBe(Date.UTC(2026, 8, 2, 9, 14, 22));
    expect(parseTimestamp("2026-09-02 11:14:22+02")).toBe(Date.UTC(2026, 8, 2, 9, 14, 22));
    expect(parseTimestamp("hello")).toBeNull();
  });
});

describe("embeddedJson", () => {
  test("objects and arrays inside text are parsed, everything else is left alone", () => {
    expect(embeddedJson('{"a":{"b":1}}')).toEqual({ a: { b: 1 } });
    expect(embeddedJson('  [1,2]')).toEqual([1, 2]);
    expect(embeddedJson("42")).toBeNull();
    expect(embeddedJson('"str"')).toBeNull();
    expect(embeddedJson("{not json}")).toBeNull();
    expect(embeddedJson("hello {}")).toBeNull();
  });
});
