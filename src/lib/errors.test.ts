import { describe, expect, test } from "bun:test";
import { describeError, errorSnippet, findIdentifier, quickFix, tokenLengthAt } from "./errors";
import { buildSchema } from "./schema";

describe("errorSnippet", () => {
  const sql = "select id\nfrom customers\nwhere create_at >= 1";
  test("points at the right line and column", () => {
    const position = sql.indexOf("create_at") + 1;
    expect(errorSnippet(sql, position)).toEqual({ line: 3, text: "where create_at >= 1", column: 6, length: 9 });
  });
  test("unknown or out of range", () => {
    expect(errorSnippet(sql, null)).toBeNull();
    expect(errorSnippet(sql, 0)).toBeNull();
    expect(errorSnippet(sql, 9999)).toBeNull();
  });
  test("tokenLengthAt", () => {
    expect(tokenLengthAt("select foo.bar from t", 8)).toBe(7);
    expect(tokenLengthAt("select ;", 8)).toBe(1);
  });
});

describe("describeError", () => {
  test("timeouts", () => {
    const e = describeError({ message: "ERROR: canceling statement due to statement timeout", code: "57014", position: null }, 30);
    expect(e.kind).toBe("timeout");
    expect(e.title).toBe("Query stopped after 30 seconds");
  });
  test("cancelled and read-only", () => {
    expect(describeError({ message: "Query was cancelled" }, 0).kind).toBe("cancelled");
    expect(describeError({ message: "ERROR: cannot execute INSERT in a read-only transaction", code: "25006", position: null }, 0).kind).toBe("readonly");
  });
  test("headline and detail are split", () => {
    const e = describeError({ message: 'ERROR: column "x" does not exist\nHINT: Perhaps you meant "y".', code: "42703", position: 8 }, 0);
    expect(e.title).toBe('column "x" does not exist');
    expect(e.detail).toBe('HINT: Perhaps you meant "y".');
    expect(e.code).toBe("42703");
  });
});

describe("quickFix", () => {
  const schema = buildSchema("postgres", [
    { sql: "", elapsed_ms: 0, error: null, result: { columns: [], rows: [["public", "customers", "r", "1", "1"]], truncated: false, message: null } },
    { sql: "", elapsed_ms: 0, error: null, result: { columns: [], rows: [["public", "customers", "created_at", "timestamptz", "false"], ["public", "customers", "name", "text", "true"]], truncated: false, message: null } },
  ]);
  test("typo in a column", () => {
    expect(quickFix('ERROR: column "create_at" does not exist', schema)).toEqual({ label: "Replace create_at with created_at", from: "create_at", to: "created_at" });
  });
  test("typo in a table", () => {
    expect(quickFix('ERROR: relation "custmers" does not exist', schema)?.to).toBe("customers");
  });
  test("nothing close, nothing known", () => {
    expect(quickFix('ERROR: column "zzzzzz" does not exist', schema)).toBeNull();
    expect(quickFix('ERROR: column "create_at" does not exist', null)).toBeNull();
    expect(quickFix("syntax error at or near", schema)).toBeNull();
  });
});

describe("findIdentifier", () => {
  test("whole word, nearest to a hint", () => {
    const sql = "select create_at, created_at from t where create_at > 1";
    expect(findIdentifier(sql, "create_at")).toBe(7);
    expect(findIdentifier(sql, "create_at", 40)).toBe(sql.lastIndexOf("create_at"));
    expect(findIdentifier(sql, "created")).toBe(-1);
  });
});
