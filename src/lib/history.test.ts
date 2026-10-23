import { describe, expect, test } from "bun:test";
import { dayLabel, formatDuration, normalizeHistory, pruneHistory, type HistoryEntry } from "./history";

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: "x", at: 1_000_000, sql: "select 1", connectionId: "c", connectionName: "local", status: "ok", ms: 5, rows: 1, affected: false, truncated: false, error: null, ...over,
});

describe("normalizeHistory", () => {
  test("garbage in, clean entries out", () => {
    const list = normalizeHistory({ entries: [null, 5, { sql: 1 }, { sql: "select 1", at: 10, status: "weird", ms: -3 }, { sql: "x", at: "no" }] });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sql: "select 1", at: 10, status: "ok", ms: 0, rows: null, connectionName: "" });
  });
  test("not an object", () => {
    expect(normalizeHistory(null)).toEqual([]);
    expect(normalizeHistory({ entries: "x" })).toEqual([]);
  });
});

describe("pruneHistory", () => {
  const now = 100 * 86_400_000;
  const list = [entry({ at: now - 1000 }), entry({ at: now - 10 * 86_400_000 }), entry({ at: now - 60 * 86_400_000 })];
  test("retention windows", () => {
    expect(pruneHistory(list, "7", now)).toHaveLength(1);
    expect(pruneHistory(list, "30", now)).toHaveLength(2);
    expect(pruneHistory(list, "forever", now)).toHaveLength(3);
    expect(pruneHistory(list, "off", now)).toHaveLength(3); // off stops recording, it does not delete
  });
});

describe("labels", () => {
  test("formatDuration", () => {
    expect(formatDuration(38)).toBe("38 ms");
    expect(formatDuration(812)).toBe("812 ms");
    expect(formatDuration(30_000)).toBe("30.0 s");
    expect(formatDuration(90_000)).toBe("1.5 min");
  });
  test("dayLabel", () => {
    const now = new Date(2026, 9, 22, 12);
    expect(dayLabel(new Date(2026, 9, 22, 3).getTime(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 21, 23).getTime(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 19, 9).getTime(), now)).toContain("19");
  });
});
