import { test, expect, describe } from "bun:test";
import { parsePgArray } from "./pgArray";

describe("parsePgArray", () => {
  test("simple unquoted elements stay strings", () => {
    expect(parsePgArray("{1,2,3}")).toEqual(["1", "2", "3"]);
    expect(parsePgArray("{a,b}")).toEqual(["a", "b"]);
    expect(parsePgArray("{1.5,-2,1e3}")).toEqual(["1.5", "-2", "1e3"]);
  });

  test("empty array", () => {
    expect(parsePgArray("{}")).toEqual([]);
    expect(parsePgArray("{ }")).toEqual([]);
  });

  test("single element", () => {
    expect(parsePgArray("{x}")).toEqual(["x"]);
  });

  test("quoted elements", () => {
    expect(parsePgArray('{"a b","c"}')).toEqual(["a b", "c"]);
    expect(parsePgArray('{""}')).toEqual([""]);
    expect(parsePgArray('{"a,b","{c}"}')).toEqual(["a,b", "{c}"]);
  });

  test("backslash escapes in quoted elements", () => {
    expect(parsePgArray('{"c\\"d"}')).toEqual(['c"d']);
    expect(parsePgArray('{"a\\\\b"}')).toEqual(["a\\b"]);
    expect(parsePgArray('{"a b","c\\"d",NULL}')).toEqual(["a b", 'c"d', null]);
  });

  test("backslash escapes in unquoted elements", () => {
    expect(parsePgArray("{a\\,b,c}")).toEqual(["a,b", "c"]);
  });

  test("unquoted NULL is null, any case", () => {
    expect(parsePgArray("{NULL}")).toEqual([null]);
    expect(parsePgArray("{null,Null,nULL}")).toEqual([null, null, null]);
    expect(parsePgArray("{1,NULL,3}")).toEqual(["1", null, "3"]);
  });

  test("quoted NULL stays a string", () => {
    expect(parsePgArray('{"NULL"}')).toEqual(["NULL"]);
    expect(parsePgArray('{"null",NULL}')).toEqual(["null", null]);
  });

  test("elements merely containing null are strings", () => {
    expect(parsePgArray("{nullable,NULLS}")).toEqual(["nullable", "NULLS"]);
  });

  test("whitespace around unquoted elements is trimmed", () => {
    expect(parsePgArray("{ 1 , 2 ,3 }")).toEqual(["1", "2", "3"]);
    expect(parsePgArray("{ a b , NULL }")).toEqual(["a b", null]);
  });

  test("whitespace inside quotes is preserved", () => {
    expect(parsePgArray('{ " a " , "b" }')).toEqual([" a ", "b"]);
  });

  test("whitespace around the whole literal", () => {
    expect(parsePgArray("  {1,2}  \n")).toEqual(["1", "2"]);
  });

  test("nested arrays", () => {
    expect(parsePgArray("{{1,2},{3,4}}")).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(parsePgArray("{{}}")).toEqual([[]]);
    expect(parsePgArray('{{"a b",NULL},{"c"}}')).toEqual([["a b", null], ["c"]]);
    expect(parsePgArray("{{{1}},{{2}}}")).toEqual([[["1"]], [["2"]]]);
    expect(parsePgArray("{ {1} , {2} }")).toEqual([["1"], ["2"]]);
  });

  test("dimension prefix is tolerated", () => {
    expect(parsePgArray("[0:2]={1,2,3}")).toEqual(["1", "2", "3"]);
    expect(parsePgArray("[1:2][1:2]={{1,2},{3,4}}")).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(parsePgArray("[0:0]={x}")).toEqual(["x"]);
  });

  test("json-like and complex element text", () => {
    expect(parsePgArray('{"{\\"a\\": 1}"}')).toEqual(['{"a": 1}']);
    expect(parsePgArray('{"2024-01-01 10:00:00+00"}')).toEqual(["2024-01-01 10:00:00+00"]);
  });

  test("semicolon is just a character", () => {
    expect(parsePgArray("{1;2}")).toEqual(["1;2"]);
  });

  test("unicode", () => {
    expect(parsePgArray("{привет,\"мир 🌍\"}")).toEqual(["привет", "мир 🌍"]);
  });

  describe("malformed input returns null", () => {
    const bad = [
      "",
      "   ",
      "abc",
      "1,2,3",
      "[1,2,3]",
      "{",
      "}",
      "{1,2",
      "{1,2}}",
      "{1,2} x",
      "{1,,2}",
      "{,}",
      "{1,}",
      "{,1}",
      '{"abc}',
      '{"abc\\"}',
      "{a\\",
      "{{1,2}",
      "{{1,2},}",
      "{1 2 {3}}",
      "{a{b}}",
      '{a"b"}',
      "[0:2]",
      "[0:2]{1}",
      "[0:2={1}",
      "[0:2]=1,2",
      "[0:2]=",
    ];
    for (const input of bad) {
      test(JSON.stringify(input), () => {
        expect(parsePgArray(input)).toBeNull();
      });
    }
  });

  test("absurd nesting returns null instead of overflowing", () => {
    const deep = "{".repeat(100000) + "}".repeat(100000);
    expect(parsePgArray(deep)).toBeNull();
  });

  test("moderate nesting works", () => {
    const depth = 50;
    const result = parsePgArray("{".repeat(depth) + "1" + "}".repeat(depth));
    let cur: unknown = result;
    for (let k = 0; k < depth - 1; k++) cur = (cur as unknown[])[0];
    expect(cur).toEqual(["1"]);
  });

  test("non-string input does not throw", () => {
    expect(parsePgArray(undefined as unknown as string)).toBeNull();
    expect(parsePgArray(null as unknown as string)).toBeNull();
  });
});
