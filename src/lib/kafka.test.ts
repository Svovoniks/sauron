import { describe, expect, test } from "bun:test";
import { displayText, emptyKafkaForm, formatTimeText, parseTimeText, isKafkaText, jsonPaths, kafkaFormOf, kafkaFormProblem, kafkaSummary, parseKafkaForm, resendForm, runnableKafkaText, serializeKafkaForm } from "./kafka";
import { isDirty, newTab, normalizeSession } from "./workspace";

describe("kafka forms", () => {
  test("round trip with defaults for missing parts", () => {
    const form = { ...emptyKafkaForm("orders"), read: { ...emptyKafkaForm().read, from: "time" as const, range: "15m" as const } };
    const text = serializeKafkaForm(form);
    expect(isKafkaText(text)).toBe(true);
    expect(parseKafkaForm(text)).toEqual(form);
    expect(parseKafkaForm('{"kafka":1,"topic":"t","read":{"limit":-5,"partitions":[1,"x",-1,2]}}')?.read).toMatchObject({ limit: 1, partitions: [1, 2], from: "newest" });
    expect(parseKafkaForm("select 1")).toBeNull();
    expect(parseKafkaForm('{"kafka":1,')).toBeNull();
    expect(isKafkaText('{"a":1}')).toBe(false);
    expect(kafkaFormOf("").topic).toBe("");
  });

  test("only the running part goes to the backend", () => {
    const form = { ...emptyKafkaForm("t"), mode: "send" as const, send: { ...emptyKafkaForm().send, value: "{}" } };
    const sent = JSON.parse(runnableKafkaText(form));
    expect(sent).toEqual({ kafka: 1, mode: "send", topic: "t", send: form.send });
    expect(JSON.parse(runnableKafkaText({ ...form, mode: "read" })).read.limit).toBe(100);
    expect(JSON.parse(runnableKafkaText({ ...form, mode: "describe" }))).toEqual({ kafka: 1, mode: "describe", topic: "t" });
  });

  test("summaries for history and saved queries", () => {
    const read = emptyKafkaForm("orders");
    read.read = { ...read.read, from: "time", range: "1h", filters: [{ field: "value.status", op: "eq", value: "failed" }, { field: "key", op: "exists", value: "" }], partitions: [2] };
    expect(kafkaSummary(serializeKafkaForm(read))).toBe("orders · last 1h · partition 2 · value.status = failed · key exists");
    const send = { ...emptyKafkaForm("orders"), mode: "send" as const, send: { ...emptyKafkaForm().send, key: "k1", value: '{\n  "a": 1\n}' } };
    expect(kafkaSummary(serializeKafkaForm(send))).toBe('send to orders · key k1 · { "a": 1 }');
    expect(displayText("select 1")).toBe("select 1");
    expect(kafkaSummary(serializeKafkaForm({ ...emptyKafkaForm("x"), mode: "describe" }))).toBe("describe x");
  });

  test("problems that stop a run", () => {
    expect(kafkaFormProblem(emptyKafkaForm(), false)).toBe("Pick a topic.");
    expect(kafkaFormProblem(emptyKafkaForm("t"), false)).toBeNull();
    expect(kafkaFormProblem({ ...emptyKafkaForm("t"), mode: "send" }, true)).toContain("read-only");
    const custom = emptyKafkaForm("t");
    custom.read = { ...custom.read, from: "time", range: "custom", sinceMs: null, untilMs: null };
    expect(kafkaFormProblem(custom, false)).toContain("start or the end");
    custom.read = { ...custom.read, sinceMs: 10, untilMs: 5 };
    expect(kafkaFormProblem(custom, false)).toContain("ends before");
    const badField = emptyKafkaForm("t");
    badField.read.filters = [{ field: "partition", op: "eq", value: "1" }];
    expect(kafkaFormProblem(badField, false)).toContain("Unknown filter field");
  });

  test("time fields take dates and pasted epochs", () => {
    const local = new Date(2026, 10, 20, 17, 52, 3, 250).getTime();
    expect(parseTimeText("2026-11-20 17:52:03.250")).toBe(local);
    expect(parseTimeText("2026-11-20T17:52:03.25")).toBe(local);
    expect(parseTimeText(" 2026-11-20 17:52 ")).toBe(new Date(2026, 10, 20, 17, 52).getTime());
    expect(parseTimeText("2026-11-20")).toBe(new Date(2026, 10, 20).getTime());
    expect(parseTimeText("2026-11-20T10:00:00Z")).toBe(Date.UTC(2026, 10, 20, 10));
    expect(parseTimeText("2026-11-20 13:00:00+0300")).toBe(Date.UTC(2026, 10, 20, 10));
    // epochs, padded to ms like the panda timestamp script does
    expect(parseTimeText("1761984446")).toBe(1761984446000);
    expect(parseTimeText("176198444612")).toBe(1761984446120);
    expect(parseTimeText("1761984446123")).toBe(1761984446123);
    expect(parseTimeText("1761984446123456")).toBe(1761984446123);
    expect(parseTimeText("1761984446123456789")).toBe(1761984446123);
    for (const bad of ["", "12345", "2026-02-31", "2026-11-20 25:00", "yesterday", "17619844461234"]) expect(parseTimeText(bad)).toBeNull();
    expect(formatTimeText(local)).toBe("2026-11-20 17:52:03.250");
    expect(parseTimeText(formatTimeText(local))).toBe(local);
  });

  test("timestamp start needs a time and is summarized", () => {
    const form = emptyKafkaForm("orders");
    form.read = { ...form.read, from: "timestamp", sinceMs: null };
    expect(kafkaFormProblem(form, false)).toContain("start reading from");
    form.read.sinceMs = new Date(2026, 10, 20, 17, 52).getTime();
    expect(kafkaFormProblem(form, false)).toBeNull();
    expect(kafkaSummary(serializeKafkaForm(form))).toBe("orders · from 2026-11-20 17:52");
    expect(parseKafkaForm(serializeKafkaForm(form))?.read.from).toBe("timestamp");
  });

  test("json paths from values", () => {
    expect(jsonPaths(['{"a":1,"b":{"c":[{"d":2}]}}', "not json", null, '{"a":2,"e.f":1}'])).toEqual(["value.a", "value.b", "value.b.c", "value.b.c.0.d"]);
  });

  test("send again keeps key, value and headers", () => {
    const form = resendForm("t", "k", '{"x":1}', '{"trace-id":"abc"}');
    expect(form.mode).toBe("send");
    expect(form.send).toMatchObject({ key: "k", value: '{"x":1}', headers: [{ name: "trace-id", value: "abc" }], partitioner: "fnv" });
  });

  test("tabs keep the form apart from their SQL", () => {
    const text = serializeKafkaForm(emptyKafkaForm("t"));
    const tab = newTab({ sql: "select 1", kafka: text, savedQueryId: "q", savedScope: "s" });
    expect(isDirty(tab, text)).toBe(false);
    expect(isDirty(tab, "select 1")).toBe(false);
    expect(isDirty({ ...tab, kafka: serializeKafkaForm(emptyKafkaForm("other")) }, text)).toBe(true);
    const restored = normalizeSession({ tabs: [{ id: "a", sql: "x", kafka: text }, { id: "b", sql: "y", kafka: "garbage" }] }, []);
    expect(restored.tabs[0].kafka).toBe(text);
    expect(restored.tabs[1].kafka).toBe("");
  });
});
