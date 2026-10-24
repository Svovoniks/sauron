import { describe, expect, test } from "bun:test";
import { CELL_DISPLAY_CHARS, cellText, clipCell, detailValue } from "./format";

describe("detailValue", () => {
  test("numeric looking text is never rewritten", () => {
    for (const text of ["18446744073709551615", "1.50", "1e3", "9007199254740993", "00123"]) {
      for (const type of ["string", "number"]) {
        const v = detailValue(type, text);
        expect(v.text).toBe(text);
        expect(v.copyText).toBe(text);
      }
    }
  });

  test("json columns are pretty printed, invalid json is shown as is", () => {
    expect(detailValue("json", '{"a":1}').text).toBe('{\n  "a": 1\n}');
    expect(detailValue("json", "not json").text).toBe("not json");
    expect(detailValue("json", "[1,2]").kind).toBe("json");
  });

  test("postgres arrays are parsed from the array literal", () => {
    const v = detailValue("array", '{1,"a b",NULL}');
    expect(JSON.parse(v.text)).toEqual(["1", "a b", null]);
    expect(v.copyText).toBe('{1,"a b",NULL}');
    expect(detailValue("array", "garbage").text).toBe("garbage");
  });

  test("null", () => {
    expect(detailValue("string", null).kind).toBe("null");
    expect(cellText(null)).toBe("null");
    expect(cellText("<<null>>")).toBe("<<null>>");
  });

  test("text 'null', 'true' and numbers in string columns stay strings", () => {
    expect(detailValue("string", "null")).toMatchObject({ kind: "string", text: "null" });
    expect(detailValue("string", "true").kind).toBe("string");
  });
});

describe("clipCell", () => {
  test("short text is untouched, long text is cut with an ellipsis", () => {
    expect(clipCell("abc")).toBe("abc");
    expect(clipCell("x".repeat(CELL_DISPLAY_CHARS))).toHaveLength(CELL_DISPLAY_CHARS);
    const long = clipCell("x".repeat(5_000_000));
    expect(long).toHaveLength(CELL_DISPLAY_CHARS + 1);
    expect(long.endsWith("…")).toBe(true);
  });
});
