import { describe, expect, test } from "bun:test";
import { firstKeyword, isRiskyMetaCommand, isWriteStatement, relativeTime, statementAt, statementLabel } from "./analyze";
import { splitSqlRanges } from "./splitStatements";

describe("firstKeyword", () => {
  test("skips whitespace, comments and parens", () => {
    expect(firstKeyword("  SELECT 1")).toBe("select");
    expect(firstKeyword("-- hi\n/* x /* nested */ y */ (with a as (select 1)) select")).toBe("with");
    expect(firstKeyword("")).toBe("");
    expect(firstKeyword("\\dt")).toBe("");
  });
});

describe("isWriteStatement", () => {
  const w = (sql: string) => isWriteStatement(sql, "postgres");
  test("plain writes", () => {
    for (const sql of ["delete from t", "UPDATE t set a = 1", "insert into t values (1)", "drop table t", "alter table t add c int", "truncate t", "create index i on t(a)", "grant select on t to x"]) {
      expect(w(sql)).toBe(true);
    }
  });
  test("reads", () => {
    for (const sql of ["select * from t", "select 'delete from t'", "-- delete\nselect 1", "show all", "explain select 1", "with a as (select 1) select * from a", "\\dt", "begin", "commit", "set search_path = a"]) {
      expect(w(sql)).toBe(false);
    }
  });
  test("data-modifying CTE and explain analyze", () => {
    expect(w("with d as (delete from t returning *) select * from d")).toBe(true);
    expect(w("explain analyze delete from t")).toBe(true);
    expect(w("explain delete from t")).toBe(false);
  });
  test("switching read-only off, locks and prepared statements count as writes", () => {
    expect(w("set default_transaction_read_only = off")).toBe(true);
    expect(w("set transaction read write")).toBe(true);
    expect(w("lock table t")).toBe(true);
    expect(w("execute stmt(1)")).toBe(true);
    expect(w("set search_path = a")).toBe(false);
    expect(w("copy t to program 'cat'")).toBe(true);
  });

  test("copy direction", () => {
    expect(w("copy t to stdout")).toBe(false);
    expect(w("copy t from stdin")).toBe(true);
  });
});

describe("isRiskyMetaCommand", () => {
  test("shell escapes and file access are risky, catalog commands are not", () => {
    expect(isRiskyMetaCommand("\\! rm -rf /")).toBe(true);
    expect(isRiskyMetaCommand("\\dt\n\\copy t to 'x'")).toBe(true);
    expect(isRiskyMetaCommand("\\i file.sql")).toBe(true);
    expect(isRiskyMetaCommand("\\dt+")).toBe(false);
    expect(isRiskyMetaCommand("\\d orders")).toBe(false);
    expect(isRiskyMetaCommand("\\dn")).toBe(false);
    expect(isRiskyMetaCommand("select 1 \\g /tmp/out")).toBe(false); // only line-leading commands are scanned
    expect(isRiskyMetaCommand("\\g /tmp/out")).toBe(true);
    expect(isRiskyMetaCommand("\\e")).toBe(true);
  });
});

describe("statementAt", () => {
  const sql = "select 1;\n\nselect 2;\nselect 3";
  const ranges = splitSqlRanges(sql, "postgres");
  test("ranges point at the trimmed text", () => {
    expect(ranges.map((r) => sql.slice(r.start, r.end))).toEqual(["select 1", "select 2", "select 3"]);
  });
  test("picks the statement under the cursor, and the previous one right after a semicolon", () => {
    expect(statementAt(ranges, 3)).toBe(0);
    expect(statementAt(ranges, 9)).toBe(0);
    expect(statementAt(ranges, 14)).toBe(1);
    expect(statementAt(ranges, sql.length)).toBe(2);
  });
  test("between statements falls back to the closest", () => {
    expect(statementAt(ranges, 10)).toBe(1);
  });
  test("no statements", () => {
    expect(statementAt([], 0)).toBe(-1);
  });
});

describe("labels and times", () => {
  test("statementLabel", () => {
    expect(statementLabel("UPDATE t set a=1")).toBe("update");
    expect(statementLabel("\\dt")).toBe("psql");
  });
  test("relativeTime", () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 hours ago");
    expect(relativeTime(now - 36 * 3_600_000, now)).toBe("yesterday");
    expect(relativeTime(now - 5 * 86_400_000, now)).toBe("5 days ago");
    expect(relativeTime(now - 30 * 86_400_000, now)).toBe("4 weeks ago");
  });
});
