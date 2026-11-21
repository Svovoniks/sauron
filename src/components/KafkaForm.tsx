import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import {
  formatTimeText,
  jsonProblem,
  parseTimeText,
  KAFKA_MAX_LIMIT,
  KAFKA_OPS,
  KAFKA_PARTITIONERS,
  KAFKA_RANGES,
  type KafkaFilter,
  type KafkaForm as Form,
  type KafkaStart,
} from "../lib/kafka";
import { CloseIcon, InfoIcon, PlusIcon } from "./icons";

interface KafkaFormProps {
  form: Form;
  onChange: (form: Form) => void;
  /** Topics of the connection with their partition counts (from the schema panel). */
  topics: { name: string; partitions: number | null }[];
  /** JSON fields seen in the current result, for the filter field suggestions. */
  jsonFields: string[];
  readOnly: boolean;
  /** Why the form cannot run right now, shown under it. */
  problem: string | null;
  onRun: () => void;
  onDescribe: () => void;
}

const STARTS: { value: KafkaStart; label: string; hint: string }[] = [
  { value: "newest", label: "Newest", hint: "The latest messages, newest first" },
  { value: "oldest", label: "Oldest", hint: "From the start of retention, oldest first" },
  { value: "time", label: "Time range", hint: "Messages in a time window, newest first" },
  { value: "timestamp", label: "Timestamp", hint: "Every partition from the first message at or after a time, oldest first" },
  { value: "offset", label: "Offset", hint: "One partition from an exact offset" },
];

/** Quick starting points for Timestamp: how far back from now. */
const TIME_PRESETS: { label: string; ago: number }[] = [
  { label: "−15m", ago: 15 * 60_000 },
  { label: "−1h", ago: 3_600_000 },
  { label: "−24h", ago: 24 * 3_600_000 },
  { label: "today", ago: -1 },
];


/** "0, 2,3" -> [0, 2, 3]; anything that is not a partition number is dropped. */
const parsePartitions = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n >= 0))];

/**
 * A time field that takes what you would paste into Redpanda Console: epoch seconds or ms (or µs, ns), or a local
 * date and time. Says how it read the text, so a pasted epoch is easy to check.
 */
function TimeInput({ value, onChange, label, placeholder }: { value: number | null; onChange: (ms: number | null) => void; label: string; placeholder: string }) {
  const [text, setText] = useState(value === null ? "" : formatTimeText(value));
  useEffect(() => {
    // Changed from outside (a preset, another tab, a restored query): show it.
    if (parseTimeText(text) !== value) setText(value === null ? "" : formatTimeText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const parsed = parseTimeText(text);
  const shown = parsed !== null ? formatTimeText(parsed) : null;
  return (
    <>
      <input
        aria-label={label}
        className={`kf-input time ${text.trim() && parsed === null ? "bad" : ""}`}
        onChange={(e) => {
          setText(e.target.value);
          const ms = parseTimeText(e.target.value);
          if (ms !== null || !e.target.value.trim()) onChange(ms);
        }}
        placeholder={placeholder}
        spellCheck={false}
        title="A local date and time (2026-11-20 17:52:03), or epoch seconds or milliseconds"
        value={text}
      />
      {text.trim() && parsed === null ? <span className="kf-note warn">not a time</span> : null}
      {shown !== null && shown !== text.trim() ? <span className="kf-note">= {shown}</span> : null}
    </>
  );
}

/** Text field for a partition list; keeps what is typed ("0, ") while the form gets the parsed numbers. */
function PartitionsInput({ value, onChange }: { value: number[]; onChange: (partitions: number[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => {
    // Changed from outside (another tab, a restored query): show it.
    if (parsePartitions(text).join(",") !== value.join(",")) setText(value.join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      aria-label="Partitions"
      className="kf-input part"
      onChange={(e) => {
        setText(e.target.value);
        onChange(parsePartitions(e.target.value));
      }}
      placeholder="all"
      spellCheck={false}
      title="Empty for every partition, or a list like 0, 2"
      value={text}
    />
  );
}

/** Read and Send forms for a query tab on a Kafka connection; it takes the place of the SQL editor. */
export function KafkaForm({ form, onChange, topics, jsonFields, readOnly, problem, onRun, onDescribe }: KafkaFormProps) {
  const ids = useId();
  const read = form.read;
  const send = form.send;
  const setRead = (patch: Partial<Form["read"]>) => onChange({ ...form, read: { ...read, ...patch } });
  const setSend = (patch: Partial<Form["send"]>) => onChange({ ...form, send: { ...send, ...patch } });
  const setFilter = (index: number, patch: Partial<KafkaFilter>) => setRead({ filters: read.filters.map((f, i) => (i === index ? { ...f, ...patch } : f)) });

  const topic = topics.find((t) => t.name === form.topic.trim()) ?? null;
  const partitions = topic?.partitions ?? null;
  const fieldOptions = useMemo(() => ["key", "value", ...jsonFields, "header."], [jsonFields]);
  const valueProblem = form.mode === "send" ? jsonProblem(send.value) : null;

  // Cmd/Ctrl+Enter runs from any field, including the value text area.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      onRun();
    }
  };

  return (
    <div className="kafka-form" onKeyDown={onKeyDown}>
      <div className="kf-row">
        <label className="kf-label" htmlFor={`${ids}-topic`}>
          Topic
        </label>
        <input
          autoComplete="off"
          className="kf-input grow"
          id={`${ids}-topic`}
          list={`${ids}-topics`}
          onChange={(event) => onChange({ ...form, topic: event.target.value })}
          placeholder={topics.length ? `one of ${topics.length.toLocaleString("en-US")} topics` : "topic name"}
          spellCheck={false}
          value={form.topic}
        />
        <datalist id={`${ids}-topics`}>
          {topics.slice(0, 5000).map((t) => (
            <option key={t.name} value={t.name}>
              {t.partitions !== null ? `${t.partitions} partitions` : ""}
            </option>
          ))}
        </datalist>
        {partitions !== null ? <span className="kf-note">{partitions} partition{partitions === 1 ? "" : "s"}</span> : null}
        <button className="kf-link" disabled={!form.topic.trim()} onClick={onDescribe} title="Partitions with their first and last offsets" type="button">
          Partitions
        </button>
        <div aria-label="Mode" className="kf-seg" role="group">
          <button aria-pressed={form.mode !== "send"} className={form.mode !== "send" ? "on" : ""} onClick={() => onChange({ ...form, mode: "read" })} type="button">
            Read
          </button>
          <button
            aria-pressed={form.mode === "send"}
            className={form.mode === "send" ? "on" : ""}
            onClick={() => onChange({ ...form, mode: "send" })}
            title={readOnly ? "This connection is read-only: turn off read-only in the connection to send messages" : "Send a message to the topic"}
            type="button"
          >
            Send
          </button>
        </div>
      </div>

      {form.mode !== "send" ? (
        <>
          <div className="kf-row">
            <span className="kf-label">Read</span>
            <div aria-label="Where to start reading" className="kf-seg" role="group">
              {STARTS.map((start) => (
                <button aria-pressed={read.from === start.value} className={read.from === start.value ? "on" : ""} key={start.value} onClick={() => setRead(start.value === "timestamp" && read.sinceMs === null ? { from: start.value, sinceMs: Date.now() - 3_600_000 } : { from: start.value })} title={start.hint} type="button">
                  {start.label}
                </button>
              ))}
            </div>
            {read.from === "time" ? (
              <div aria-label="Time range" className="kf-chips" role="group">
                {KAFKA_RANGES.map((range) => (
                  <button
                    aria-pressed={read.range === range.value}
                    className={`kf-chip ${read.range === range.value ? "on" : ""}`}
                    key={range.value}
                    onClick={() => setRead(range.value === "custom" && read.sinceMs === null && read.untilMs === null ? { range: "custom", sinceMs: Date.now() - 3_600_000 } : { range: range.value })}
                    type="button"
                  >
                    {range.label}
                  </button>
                ))}
              </div>
            ) : null}
            {read.from === "offset" ? (
              <>
                <span className="kf-note">partition</span>
                <input aria-label="Partition" className="kf-input num" min={0} max={partitions !== null ? partitions - 1 : undefined} onChange={(e) => setRead({ offsetPartition: Math.max(0, Number(e.target.value) || 0) })} type="number" value={read.offsetPartition} />
                <span className="kf-note">from offset</span>
                <input aria-label="Offset" className="kf-input wide-num" min={0} onChange={(e) => setRead({ offset: Math.max(0, Number(e.target.value) || 0) })} type="number" value={read.offset} />
              </>
            ) : (
              <>
                <span className="kf-note">partitions</span>
                <PartitionsInput onChange={(partitions) => setRead({ partitions })} value={read.partitions} />
              </>
            )}
            <span className="kf-note">limit</span>
            <input aria-label="Limit" className="kf-input num" max={KAFKA_MAX_LIMIT} min={1} onChange={(e) => setRead({ limit: Math.min(KAFKA_MAX_LIMIT, Math.max(1, Number(e.target.value) || 1)) })} type="number" value={read.limit} />
          </div>

          {read.from === "time" && read.range === "custom" ? (
            <div className="kf-row">
              <span className="kf-label" />
              <TimeInput label="From" onChange={(sinceMs) => setRead({ sinceMs })} placeholder="from" value={read.sinceMs} />
              <span className="kf-note">to</span>
              <TimeInput label="To" onChange={(untilMs) => setRead({ untilMs })} placeholder="now" value={read.untilMs} />
            </div>
          ) : null}

          {read.from === "timestamp" ? (
            <div className="kf-row">
              <span className="kf-label">From</span>
              <TimeInput label="Start time" onChange={(sinceMs) => setRead({ sinceMs })} placeholder="2026-11-20 17:52 or 1761984446000" value={read.sinceMs} />
              <div aria-label="Start time presets" className="kf-chips" role="group">
                {TIME_PRESETS.map((preset) => (
                  <button
                    className="kf-chip"
                    key={preset.label}
                    onClick={() => setRead({ sinceMs: preset.ago < 0 ? new Date(new Date().setHours(0, 0, 0, 0)).getTime() : Date.now() - preset.ago })}
                    type="button"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {read.filters.map((filter, index) => (
            <div className="kf-row" key={index}>
              <span className="kf-label">{index === 0 ? "Filters" : "and"}</span>
              <input aria-label="Filter field" className="kf-input field" list={`${ids}-fields`} onChange={(e) => setFilter(index, { field: e.target.value })} placeholder="value.status" spellCheck={false} value={filter.field} />
              <select aria-label="Filter operator" className="kf-input" onChange={(e) => setFilter(index, { op: e.target.value as KafkaFilter["op"] })} value={filter.op}>
                {KAFKA_OPS.map((op) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </select>
              {filter.op === "exists" ? <span className="grow" /> : <input aria-label="Filter value" className="kf-input grow" onChange={(e) => setFilter(index, { value: e.target.value })} spellCheck={false} value={filter.value} />}
              <button aria-label="Remove filter" className="kf-x" onClick={() => setRead({ filters: read.filters.filter((_, i) => i !== index) })} type="button">
                <CloseIcon />
              </button>
            </div>
          ))}
          <datalist id={`${ids}-fields`}>
            {fieldOptions.map((field) => (
              <option key={field} value={field} />
            ))}
          </datalist>
          <div className="kf-row">
            <span className="kf-label">{read.filters.length === 0 ? "Filters" : ""}</span>
            <button className="kf-link" onClick={() => setRead({ filters: [...read.filters, { field: read.filters.length === 0 ? "value." : "key", op: "eq", value: "" }] })} type="button">
              <PlusIcon size={11} /> Add filter
            </button>
            {read.filters.length > 0 ? <span className="kf-note">checked on every message read: a time range keeps the search short</span> : null}
          </div>
        </>
      ) : (
        <>
          <div className="kf-row">
            <label className="kf-label" htmlFor={`${ids}-partitioner`}>
              Partition
            </label>
            <select className="kf-input" id={`${ids}-partitioner`} onChange={(e) => setSend({ partitioner: e.target.value as Form["send"]["partitioner"] })} title={KAFKA_PARTITIONERS.find((p) => p.value === send.partitioner)?.hint} value={send.partitioner}>
              {KAFKA_PARTITIONERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            {send.partitioner === "manual" ? (
              <input aria-label="Partition" className="kf-input num" max={partitions !== null ? partitions - 1 : undefined} min={0} onChange={(e) => setSend({ partition: Math.max(0, Number(e.target.value) || 0) })} type="number" value={send.partition} />
            ) : (
              <span className="kf-note">{send.key ? "the key decides the partition" : "no key: a random partition"}</span>
            )}
            <label className="kf-label short" htmlFor={`${ids}-key`}>
              Key
            </label>
            <input className="kf-input grow" id={`${ids}-key`} onChange={(e) => setSend({ key: e.target.value })} placeholder="(none)" spellCheck={false} value={send.key} />
          </div>
          <div className="kf-row top">
            <label className="kf-label" htmlFor={`${ids}-value`}>
              Value
            </label>
            <textarea className="kf-input kf-value" id={`${ids}-value`} onChange={(e) => setSend({ value: e.target.value })} placeholder='{"id": 1}' spellCheck={false} value={send.value} />
          </div>
          <div className="kf-row">
            <span className="kf-label" />
            {send.value.trim() === "" ? (
              <span className="kf-note">empty value</span>
            ) : valueProblem ? (
              <span className="kf-note warn">not JSON ({valueProblem}): it is sent as plain text</span>
            ) : (
              <span className="kf-note ok">valid JSON</span>
            )}
            <button className="kf-link" disabled={!!valueProblem || !send.value.trim()} onClick={() => setSend({ value: JSON.stringify(JSON.parse(send.value), null, 2) })} type="button">
              Format
            </button>
          </div>
          {send.headers.map((header, index) => (
            <div className="kf-row" key={index}>
              <span className="kf-label">{index === 0 ? "Headers" : ""}</span>
              <input aria-label="Header name" className="kf-input field" onChange={(e) => setSend({ headers: send.headers.map((h, i) => (i === index ? { ...h, name: e.target.value } : h)) })} placeholder="name" spellCheck={false} value={header.name} />
              <input aria-label="Header value" className="kf-input grow" onChange={(e) => setSend({ headers: send.headers.map((h, i) => (i === index ? { ...h, value: e.target.value } : h)) })} placeholder="value" spellCheck={false} value={header.value} />
              <button aria-label="Remove header" className="kf-x" onClick={() => setSend({ headers: send.headers.filter((_, i) => i !== index) })} type="button">
                <CloseIcon />
              </button>
            </div>
          ))}
          <div className="kf-row">
            <span className="kf-label">{send.headers.length === 0 ? "Headers" : ""}</span>
            <button className="kf-link" onClick={() => setSend({ headers: [...send.headers, { name: "", value: "" }] })} type="button">
              <PlusIcon size={11} /> Add header
            </button>
          </div>
        </>
      )}

      {problem ? (
        <div className="kf-problem" role="status">
          <InfoIcon size={13} />
          {problem}
        </div>
      ) : null}
    </div>
  );
}
