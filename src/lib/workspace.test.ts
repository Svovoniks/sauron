import { describe, expect, test } from "bun:test";
import type { Connection } from "../types/app";
import { isDirty, neighbourAfterClose, newTab, nextUntitledName, normalizeSession, sortPinned } from "./workspace";

const conn = (id: string): Connection => ({ id, name: id, host: "h", port: "5432", username: "", database: "", db_type: "postgres", ssl_mode: "require", read_only: true, timeout_secs: 0, env: "", description: "", ssl_root_cert: "", ssl_cert: "", ssl_key: "", use_default_certs: false });

describe("tabs", () => {
  test("untitled names do not collide", () => {
    const a = newTab({}, []);
    const b = newTab({}, [a]);
    expect([a.name, b.name]).toEqual(["untitled 1", "untitled 2"]);
    expect(nextUntitledName([{ ...a, name: "untitled 2" }])).toBe("untitled 1");
  });
  test("pinned first, stable", () => {
    const t = (id: string, pinned: boolean) => newTab({ id, pinned });
    expect(sortPinned([t("a", false), t("b", true), t("c", false), t("d", true)]).map((x) => x.id)).toEqual(["b", "d", "a", "c"]);
  });
  test("neighbour after close", () => {
    const tabs = ["a", "b", "c"].map((id) => newTab({ id }));
    expect(neighbourAfterClose(tabs, "b")).toBe("c");
    expect(neighbourAfterClose(tabs, "c")).toBe("b");
    expect(neighbourAfterClose([tabs[0]], "a")).toBeNull();
  });
  test("dirty only compares tabs linked to a saved query", () => {
    expect(isDirty(newTab({ sql: "x" }), null)).toBe(false);
    expect(isDirty(newTab({ sql: "x", savedQueryId: "q" }), "x")).toBe(false);
    expect(isDirty(newTab({ sql: "y", savedQueryId: "q" }), "x")).toBe(true);
    expect(isDirty(newTab({ sql: "y", savedQueryId: "q" }), null)).toBe(false);
  });
});

describe("normalizeSession", () => {
  test("drops garbage, unknown connections and duplicate ids", () => {
    const s = normalizeSession(
      { activeTabId: "b", tabs: [null, { sql: 1 }, { id: "a", sql: "select 1", connectionId: "gone", name: "  " }, { id: "a", sql: "select 2", connectionId: "c1", pinned: true }, { id: "b", sql: "x", name: "mine" }] },
      [conn("c1")],
    );
    expect(s.tabs).toHaveLength(3);
    expect(s.tabs[0]).toMatchObject({ connectionId: null, name: "untitled" });
    expect(new Set(s.tabs.map((t) => t.id)).size).toBe(3);
    expect(s.tabs[1]).toMatchObject({ connectionId: "c1", pinned: true });
    expect(s.activeTabId).toBe("b");
  });
  test("unknown active tab falls back to the first", () => {
    const s = normalizeSession({ activeTabId: "nope", tabs: [{ id: "a", sql: "" }] }, []);
    expect(s.activeTabId).toBe("a");
  });
  test("not a session", () => {
    expect(normalizeSession(null, [])).toEqual({ activeTabId: null, tabs: [] });
    expect(normalizeSession({ tabs: "x" }, [])).toEqual({ activeTabId: null, tabs: [] });
  });
});
