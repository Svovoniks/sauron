import { describe, expect, test } from "bun:test";
import { expandPastedHosts, fromHostRows, toHostRows } from "./hostList";

describe("toHostRows", () => {
  test("single host", () => {
    expect(toHostRows("db.local", "5432")).toEqual([{ host: "db.local", port: "5432" }]);
    expect(toHostRows("", "5432")).toEqual([{ host: "", port: "5432" }]);
  });
  test("one port for every host, or one per host", () => {
    expect(toHostRows("a, b,,c", "6433")).toEqual([
      { host: "a", port: "6433" },
      { host: "b", port: "6433" },
      { host: "c", port: "6433" },
    ]);
    expect(toHostRows("a,b", "1, 2")).toEqual([
      { host: "a", port: "1" },
      { host: "b", port: "2" },
    ]);
  });
});

describe("fromHostRows", () => {
  test("same port is written once", () => {
    expect(fromHostRows([{ host: " a ", port: "6433" }, { host: "b", port: "6433 " }])).toEqual({ host: "a,b", port: "6433" });
    expect(fromHostRows([{ host: "db.local", port: "5432" }])).toEqual({ host: "db.local", port: "5432" });
  });
  test("different ports become a list, blank rows are left out", () => {
    expect(fromHostRows([{ host: "a", port: "1" }, { host: "", port: "9" }, { host: "b", port: "2" }])).toEqual({ host: "a,b", port: "1,2" });
    expect(fromHostRows([{ host: " ", port: "5432" }])).toEqual({ host: "", port: "5432" });
  });
  test("round trip", () => {
    for (const [host, port] of [["a,b,c", "6433"], ["a,b", "1,2"], ["h", "5432"]]) expect(fromHostRows(toHostRows(host, port))).toEqual({ host, port });
  });
});

describe("expandPastedHosts", () => {
  test("a comma list typed into one row becomes rows on that row's port", () => {
    const rows = [{ host: "x", port: "1" }, { host: "", port: "6433" }, { host: "z", port: "3" }];
    expect(expandPastedHosts(rows, 1, "a, b")).toEqual([
      { host: "x", port: "1" },
      { host: "a", port: "6433" },
      { host: "b", port: "6433" },
      { host: "z", port: "3" },
    ]);
    expect(expandPastedHosts(rows, 0, "y")[0]).toEqual({ host: "y", port: "1" });
  });
});
