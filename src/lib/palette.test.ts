import { describe, expect, test } from "bun:test";
import { fuzzyMatch } from "./palette";

describe("fuzzyMatch", () => {
  test("empty query matches everything with no highlights", () => {
    expect(fuzzyMatch("Execute", "")).toEqual({ score: 0, indexes: [] });
  });
  test("contiguous beats subsequence, word start beats middle", () => {
    const contiguous = fuzzyMatch("Row limit", "lim")!;
    const middle = fuzzyMatch("Default query timeout limit", "ime")!;
    const subsequence = fuzzyMatch("Show NULL as", "sna")!;
    expect(contiguous.indexes).toEqual([4, 5, 6]);
    expect(contiguous.score).toBeGreaterThan(middle.score);
    expect(middle.score).toBeGreaterThan(subsequence.score);
  });
  test("subsequence only jumps on word starts", () => {
    expect(fuzzyMatch("New connection", "nc")?.indexes).toEqual([0, 4]);
    expect(fuzzyMatch("Execute", "xq")).toBeNull();
    expect(fuzzyMatch("Execute", "ect")).toBeNull();
  });
  test("no match", () => {
    expect(fuzzyMatch("Settings", "zzz")).toBeNull();
  });
  test("case insensitive", () => {
    expect(fuzzyMatch("Open Settings", "SETT")).not.toBeNull();
  });
});
