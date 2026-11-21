/**
 * The Kafka form of a query tab. It travels as JSON text (see kafka.rs): the tab, saved queries, history and the
 * agent log keep that text, and execute_script runs it like a one-statement script.
 */

export type KafkaMode = "read" | "send" | "describe" | "topics";
export type KafkaStart = "newest" | "oldest" | "time" | "offset" | "timestamp";
export type KafkaRange = "15m" | "1h" | "6h" | "24h" | "7d" | "custom";
export type KafkaOp = "eq" | "ne" | "contains" | "not_contains" | "exists" | "gt" | "lt";
export type KafkaPartitioner = "fnv" | "murmur2" | "manual";

export interface KafkaFilter {
  /** key, value, value.some.path (a JSON field) or header.name */
  field: string;
  op: KafkaOp;
  value: string;
}

export interface KafkaHeader {
  name: string;
  value: string;
}

export interface KafkaForm {
  kafka: 1;
  mode: KafkaMode;
  topic: string;
  read: {
    from: KafkaStart;
    /** Empty: every partition. */
    partitions: number[];
    range: KafkaRange;
    sinceMs: number | null;
    untilMs: number | null;
    offsetPartition: number;
    offset: number;
    filters: KafkaFilter[];
    limit: number;
  };
  send: {
    partitioner: KafkaPartitioner;
    partition: number;
    key: string;
    value: string;
    headers: KafkaHeader[];
  };
}

export const KAFKA_DEFAULT_LIMIT = 100;
export const KAFKA_MAX_LIMIT = 100_000;

export const KAFKA_RANGES: { value: KafkaRange; label: string }[] = [
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "custom", label: "Custom" },
];

export const KAFKA_OPS: { value: KafkaOp; label: string }[] = [
  { value: "eq", label: "=" },
  { value: "ne", label: "≠" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
  { value: "exists", label: "exists" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
];

export const KAFKA_PARTITIONERS: { value: KafkaPartitioner; label: string; hint: string }[] = [
  { value: "fnv", label: "By key (FNV-1a)", hint: "The sarama default: messages with the same key land in the same partition as a sarama producer puts them." },
  { value: "murmur2", label: "By key (murmur2)", hint: "The Java client default, also used by franz-go." },
  { value: "manual", label: "Partition…", hint: "Send to the partition picked here." },
];

export const emptyKafkaForm = (topic = ""): KafkaForm => ({
  kafka: 1,
  mode: "read",
  topic,
  read: { from: "newest", partitions: [], range: "1h", sinceMs: null, untilMs: null, offsetPartition: 0, offset: 0, filters: [], limit: KAFKA_DEFAULT_LIMIT },
  send: { partitioner: "fnv", partition: 0, key: "", value: "", headers: [] },
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (typeof v === "string" && (options as readonly string[]).includes(v) ? (v as T) : fallback);
const int = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const msOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Does this text hold a Kafka form (rather than SQL)? */
export const isKafkaText = (text: string | null | undefined): boolean => typeof text === "string" && /^\s*\{\s*"kafka"\s*:/.test(text);

/** The form in a text, with defaults for anything missing; null when the text is not a Kafka form. */
export function parseKafkaForm(text: string | null | undefined): KafkaForm | null {
  if (!isKafkaText(text)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text as string);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const base = emptyKafkaForm();
  const read = isRecord(raw.read) ? raw.read : {};
  const send = isRecord(raw.send) ? raw.send : {};
  return {
    kafka: 1,
    mode: oneOf(raw.mode, ["read", "send", "describe", "topics"] as const, "read"),
    topic: str(raw.topic),
    read: {
      from: oneOf(read.from, ["newest", "oldest", "time", "offset", "timestamp"] as const, base.read.from),
      partitions: Array.isArray(read.partitions) ? read.partitions.filter((p): p is number => Number.isInteger(p) && p >= 0) : [],
      range: oneOf(read.range, KAFKA_RANGES.map((r) => r.value), base.read.range),
      sinceMs: msOrNull(read.sinceMs),
      untilMs: msOrNull(read.untilMs),
      offsetPartition: Math.max(0, int(read.offsetPartition, 0)),
      offset: Math.max(0, int(read.offset, 0)),
      filters: Array.isArray(read.filters)
        ? read.filters.filter(isRecord).map((f) => ({ field: str(f.field), op: oneOf(f.op, KAFKA_OPS.map((o) => o.value), "eq"), value: str(f.value) }))
        : [],
      limit: Math.min(KAFKA_MAX_LIMIT, Math.max(1, int(read.limit, KAFKA_DEFAULT_LIMIT))),
    },
    send: {
      partitioner: oneOf(send.partitioner, ["fnv", "murmur2", "manual"] as const, "fnv"),
      partition: Math.max(0, int(send.partition, 0)),
      key: str(send.key),
      value: str(send.value),
      headers: Array.isArray(send.headers) ? send.headers.filter(isRecord).map((h) => ({ name: str(h.name), value: str(h.value) })) : [],
    },
  };
}

/** The form as the text a tab keeps; the "kafka" marker goes first so isKafkaText recognises it. */
export const serializeKafkaForm = (form: KafkaForm): string => JSON.stringify({ ...form, kafka: 1 });

/** A form for the text of a tab: the stored one, or a fresh one. */
export const kafkaFormOf = (text: string | null | undefined): KafkaForm => parseKafkaForm(text) ?? emptyKafkaForm();

/** Only the part of the form that runs: read or send, not the other one. */
export function runnableKafkaText(form: KafkaForm): string {
  if (form.mode === "send") return JSON.stringify({ kafka: 1, mode: "send", topic: form.topic, send: form.send });
  if (form.mode === "read") return JSON.stringify({ kafka: 1, mode: "read", topic: form.topic, read: form.read });
  return JSON.stringify({ kafka: 1, mode: form.mode, topic: form.topic });
}

const opText = (op: KafkaOp) => KAFKA_OPS.find((o) => o.value === op)?.label ?? op;

const timeText = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** One line for history, saved queries, the palette and the agent log: "orders · last 1h · value.status = failed". */
export function kafkaSummary(text: string): string {
  const form = parseKafkaForm(text);
  if (!form) return text;
  const topic = form.topic || "(no topic)";
  if (form.mode === "topics") return "list topics";
  if (form.mode === "describe") return `describe ${topic}`;
  if (form.mode === "send") {
    const value = form.send.value.replace(/\s+/g, " ").trim();
    return `send to ${topic}${form.send.key ? ` · key ${form.send.key}` : ""}${form.send.partitioner === "manual" ? ` · partition ${form.send.partition}` : ""} · ${value.length > 60 ? `${value.slice(0, 60)}…` : value || "(empty)"}`;
  }
  const r = form.read;
  const parts = [topic];
  if (r.from === "newest") parts.push("newest");
  else if (r.from === "oldest") parts.push("oldest");
  else if (r.from === "offset") parts.push(`partition ${r.offsetPartition} from offset ${r.offset}`);
  else if (r.from === "timestamp") parts.push(`from ${r.sinceMs !== null ? timeText(r.sinceMs) : "…"}`);
  else if (r.range !== "custom") parts.push(`last ${r.range}`);
  else parts.push(`${r.sinceMs !== null ? timeText(r.sinceMs) : "…"} to ${r.untilMs !== null ? timeText(r.untilMs) : "now"}`);
  if (r.from !== "offset" && r.partitions.length > 0) parts.push(`partition${r.partitions.length === 1 ? "" : "s"} ${r.partitions.join(", ")}`);
  for (const f of r.filters) parts.push(f.op === "exists" ? `${f.field} exists` : `${f.field} ${opText(f.op)} ${f.value}`);
  return parts.join(" · ");
}

/** Text to show for a tab, history entry or saved query: SQL as it is, a Kafka form as its summary. */
export const displayText = (text: string): string => (isKafkaText(text) ? kafkaSummary(text) : text);

/** Problems that stop the form from running, or null. */
export function kafkaFormProblem(form: KafkaForm, readOnly: boolean): string | null {
  if (form.mode !== "topics" && !form.topic.trim()) return "Pick a topic.";
  if (form.mode === "send") {
    if (readOnly) return "This connection is read-only. Turn off read-only in the connection to send messages.";
    return null;
  }
  if (form.mode === "read") {
    const r = form.read;
    if (r.from === "timestamp" && r.sinceMs === null) return "Set the time to start reading from.";
    if (r.from === "time" && r.range === "custom") {
      if (r.sinceMs === null && r.untilMs === null) return "Set the start or the end of the time range.";
      if (r.sinceMs !== null && r.untilMs !== null && r.sinceMs >= r.untilMs) return "The time range ends before it starts.";
    }
    const bad = r.filters.find((f) => !/^(key|value|value\..+|header\..+)$/.test(f.field.trim()));
    if (bad) return `Unknown filter field "${bad.field}": use key, value, value.<json path> or header.<name>.`;
  }
  return null;
}

/**
 * A time typed or pasted into a time field, as epoch ms (null when it is not a time):
 * - epoch digits: 10 (seconds) to 13 (ms) digits are padded to ms, like a Redpanda Console timestamp; 16 are µs, 19 are ns
 * - 2026-11-20 17:52, 2026-11-20 17:52:03.250 or 2026-11-20 (local time), with a T instead of the space too
 * - the same with a zone: 2026-11-20T17:52:03Z, 2026-11-20 17:52:03+03:00
 */
export function parseTimeText(text: string): number | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) {
    if (t.length >= 10 && t.length <= 13) return Number(t.padEnd(13, "0"));
    if (t.length === 16) return Math.floor(Number(t) / 1_000);
    if (t.length === 19) return Math.floor(Number(t.slice(0, 13)));
    return null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(t);
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", sec = "00", frac = "", zone] = m;
  const ms = Number(frac.padEnd(3, "0").slice(0, 3));
  if (zone) {
    const z = zone.toUpperCase() === "Z" ? "Z" : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    const parsed = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}.${String(ms).padStart(3, "0")}${z}`);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec), ms);
  // new Date rolls 2026-02-31 over to March: that is a typo, not a time.
  if (date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d) || Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return null;
  return date.getTime();
}

/** epoch ms as local time with seconds and ms: 2026-11-20 17:52:03.250 */
export function formatTimeText(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Does a send value look like JSON? (A value that is not JSON may still be sent.) */
export function jsonProblem(value: string): string | null {
  if (!value.trim()) return null;
  try {
    JSON.parse(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "not valid JSON";
  }
}

/** JSON field paths of the values in a result, for the filter field suggestions: value.status, value.items.0.sku, ... */
export function jsonPaths(values: (string | null)[], max = 200): string[] {
  const paths = new Set<string>();
  const walk = (value: unknown, path: string, depth: number) => {
    if (paths.size >= max || depth > 4) return;
    if (Array.isArray(value)) {
      if (value.length > 0) walk(value[0], `${path}.0`, depth + 1);
      return;
    }
    if (isRecord(value)) {
      for (const [key, inner] of Object.entries(value)) {
        if (key.includes(".")) continue;
        const next = `${path}.${key}`;
        paths.add(next);
        walk(inner, next, depth + 1);
      }
    }
  };
  for (const text of values.slice(0, 50)) {
    if (!text || !/^\s*[[{]/.test(text)) continue;
    try {
      walk(JSON.parse(text), "value", 0);
    } catch {
      /* not JSON */
    }
  }
  return [...paths].sort();
}

/** A send form filled from a message of a result (Send again…). */
export function resendForm(topic: string, key: string | null, value: string | null, headers: string | null): KafkaForm {
  const form = emptyKafkaForm(topic);
  let list: KafkaHeader[] = [];
  if (headers) {
    try {
      const parsed: unknown = JSON.parse(headers);
      if (isRecord(parsed)) list = Object.entries(parsed).map(([name, v]) => ({ name, value: typeof v === "string" ? v : JSON.stringify(v) }));
    } catch {
      /* no headers */
    }
  }
  return { ...form, mode: "send", send: { ...form.send, key: key ?? "", value: value ?? "", headers: list } };
}
