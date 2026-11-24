import type { QueryResult } from "../types/app";

/**
 * Development only: believable shop data for the dev mock (see tauriMock.ts), used with ?demo in the dev URL
 * so screen recordings and screenshots for the README look like a real database. Everything is generated from
 * a fixed seed, so the same query always shows the same rows.
 */

/** Small deterministic PRNG (mulberry32), so every run of the demo shows the same data. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)];
const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Postgres-style timestamptz text in UTC, like "2026-11-24 14:03:11.482+00". */
const pgTime = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}+00`;
};

/** Local time with the zone, the way the Kafka backend formats message timestamps. */
const localTime = (ms: number) => {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const zone = `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${zone}`;
};

const FIRST = ["Ada", "Linus", "Grace", "Alan", "Margaret", "Ken", "Barbara", "Dennis", "Frances", "Edsger", "Radia", "John", "Sophie", "Tim", "Hedy", "Niklaus", "Karen", "Bjarne", "Annie", "Guido"];
const LAST = ["Lovelace", "Torvalds", "Hopper", "Turing", "Hamilton", "Thompson", "Liskov", "Ritchie", "Allen", "Dijkstra", "Perlman", "Backus", "Wilson", "Berners-Lee", "Lamarr", "Wirth", "Spärck Jones", "Stroustrup", "Easley", "van Rossum"];
const CITIES = ["Berlin", "Lisbon", "Warsaw", "Amsterdam", "Prague", "Vienna", "Madrid", "Oslo", "Dublin", "Helsinki"];
const PLANS = ["free", "starter", "team", "business", "enterprise"] as const;
const STATUSES = ["paid", "paid", "paid", "shipped", "shipped", "delivered", "new", "cancelled", "refunded"] as const;
const CHANNELS = ["web", "web", "ios", "android", "partner-api"];
const SHIPPING = ["courier", "pickup-point", "post", "express"];
const PRODUCTS = [
  { sku: "KB-104", title: "Mechanical keyboard", price: 129.9 },
  { sku: "MS-220", title: "Wireless mouse", price: 39.5 },
  { sku: "MN-27Q", title: "27\" QHD monitor", price: 319 },
  { sku: "HD-900", title: "Noise cancelling headphones", price: 249 },
  { sku: "DK-USB4", title: "USB4 dock", price: 189 },
  { sku: "CB-C2C", title: "USB-C cable, 2 m", price: 14.9 },
  { sku: "ST-ARM", title: "Monitor arm", price: 89 },
  { sku: "LP-STD", title: "Laptop stand", price: 49 },
];

interface Customer { id: number; name: string; email: string; plan: string; seats: number; active: boolean; city: string; created: number }

const NOW = Date.UTC(2026, 10, 24, 15, 42, 0);
const DAY = 86_400_000;

const CUSTOMERS: Customer[] = (() => {
  const r = rng(7);
  return Array.from({ length: 480 }, (_, i) => {
    const first = pick(r, FIRST);
    const last = pick(r, LAST);
    const plan = pick(r, PLANS);
    return {
      id: 1001 + i,
      name: `${first} ${last}`,
      email: `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, "") + `${i % 9 === 0 ? i : ""}@example.com`,
      plan,
      seats: plan === "free" ? 1 : plan === "starter" ? 1 + Math.floor(r() * 5) : plan === "team" ? 5 + Math.floor(r() * 20) : 20 + Math.floor(r() * 400),
      active: r() > 0.12,
      city: pick(r, CITIES),
      created: NOW - Math.floor(r() * 700 * DAY),
    };
  });
})();

interface Order { id: number; customer: Customer; status: string; total: number; created: number; meta: Record<string, unknown> }

const ORDERS: Order[] = (() => {
  const r = rng(11);
  let at = NOW - 4 * 60_000;
  return Array.from({ length: 6000 }, (_, i) => {
    at -= Math.floor(20_000 + r() * 260_000);
    const customer = pick(r, CUSTOMERS);
    const items = Array.from({ length: 1 + Math.floor(r() * 3) }, () => {
      const p = pick(r, PRODUCTS);
      return { sku: p.sku, title: p.title, qty: r() > 0.8 ? 2 : 1, price: p.price };
    });
    const total = Math.round(items.reduce((sum, it) => sum + it.qty * it.price, 0) * 100) / 100;
    const coupon = r() > 0.75 ? pick(r, ["WELCOME10", "BLACKFRIDAY", "SPRING5"]) : null;
    return {
      id: 48210 - i,
      customer,
      status: i < 6 ? "new" : pick(r, STATUSES),
      total,
      created: at,
      meta: {
        channel: pick(r, CHANNELS),
        coupon,
        shipping: { method: pick(r, SHIPPING), city: customer.city, eta_days: 1 + Math.floor(r() * 4) },
        items,
        payment: { provider: pick(r, ["stripe", "adyen", "paypal"]), captured: true },
      },
    };
  });
})();

const result = (columns: [string, string][], rows: (string | null)[][], rowLimit: number, message: string | null = null): QueryResult => ({
  columns: columns.map(([name, type]) => ({ name, type })),
  rows: rows.slice(0, rowLimit),
  truncated: rows.length > rowLimit,
  message,
});

/** Applies a "status = 'x'" style filter found in the SQL, so a typed where clause visibly changes the rows. */
function whereEquals(sql: string, column: string): string | null {
  const m = new RegExp(`\\b${column}\\s*=\\s*'([^']*)'`, "i").exec(sql);
  return m ? m[1] : null;
}

/** Rows for a demo SQL statement, or null to fall back to the mock's test data. */
export function demoQuery(sql: string, rowLimit: number): QueryResult | null {
  const text = sql.toLowerCase();
  if (/\bfrom\s+orders\b/.test(text) && /group\s+by/.test(text)) {
    const groups = new Map<string, { count: number; sum: number }>();
    for (const o of ORDERS) {
      const g = groups.get(o.status) ?? { count: 0, sum: 0 };
      g.count++;
      g.sum += o.total;
      groups.set(o.status, g);
    }
    const rows = [...groups.entries()].sort((a, b) => b[1].count - a[1].count).map(([status, g]) => [status, String(g.count), g.sum.toFixed(2)]);
    return result([["status", "string"], ["count", "number"], ["sum", "number"]], rows, rowLimit);
  }
  if (/\bfrom\s+orders\b/.test(text)) {
    const status = whereEquals(sql, "status");
    const orders = ORDERS.filter((o) => status === null || o.status === status);
    const joined = /\bjoin\s+customers\b/.test(text);
    const columns: [string, string][] = joined
      ? [["id", "number"], ["customer", "string"], ["status", "string"], ["total", "number"], ["created_at", "timestamp tz"], ["meta", "json"]]
      : [["id", "number"], ["customer_id", "number"], ["status", "string"], ["total", "number"], ["currency", "string"], ["created_at", "timestamp tz"], ["meta", "json"]];
    const rows = orders.map((o) =>
      joined
        ? [String(o.id), o.customer.name, o.status, o.total.toFixed(2), pgTime(o.created), JSON.stringify(o.meta)]
        : [String(o.id), String(o.customer.id), o.status, o.total.toFixed(2), "EUR", pgTime(o.created), JSON.stringify(o.meta)],
    );
    return result(columns, rows, rowLimit);
  }
  if (/\bfrom\s+customers\b/.test(text)) {
    const plan = whereEquals(sql, "plan");
    const paying = /plan\s*<>\s*'free'/.test(text);
    const customers = CUSTOMERS.filter((c) => (plan === null || c.plan === plan) && (!paying || (c.plan !== "free" && c.active)));
    if (/order\s+by\s+seats\s+desc/.test(text)) customers.sort((a, b) => b.seats - a.seats);
    const rows = customers.map((c) => [String(c.id), c.name, c.email, c.plan, String(c.seats), String(c.active), c.city, pgTime(c.created)]);
    return result(
      [["id", "number"], ["name", "string"], ["email", "string"], ["plan", "string"], ["seats", "number"], ["active", "bool"], ["city", "string"], ["created_at", "timestamp tz"]],
      rows,
      rowLimit,
    );
  }
  if (/\bfrom\s+products\b/.test(text)) {
    return result([["id", "number"], ["sku", "string"], ["title", "string"], ["price", "number"]], PRODUCTS.map((p, i) => [String(i + 1), p.sku, p.title, p.price.toFixed(2)]), rowLimit);
  }
  return null;
}

// --- Kafka ----------------------------------------------------------------------------------------

const TOPICS: [string, number][] = [
  ["customer-signups", 3],
  ["inventory-updates", 6],
  ["order-events", 12],
  ["payment-events", 6],
  ["shipment-tracking", 6],
];

interface KafkaMessage { partition: number; offset: number; at: number; key: string; value: Record<string, unknown>; headers: Record<string, string> }

const hex = (r: () => number, length: number) => Array.from({ length }, () => Math.floor(r() * 16).toString(16)).join("");

/** Messages of one topic, newest first, made up from the demo orders. */
function topicMessages(topic: string): KafkaMessage[] {
  const r = rng(topic.length * 131);
  const partitions = TOPICS.find(([name]) => name === topic)?.[1] ?? 1;
  const offsets = Array.from({ length: partitions }, (_, p) => 182_000 + p * 977);
  let at = Date.now() - 1_500;
  return ORDERS.slice(0, 900).map((o, i) => {
    at -= Math.floor(400 + r() * 5_000);
    const partition = o.id % partitions;
    const offset = offsets[partition]--;
    const event = topic === "payment-events" ? pick(r, ["payment.authorized", "payment.captured", "payment.captured", "payment.failed"]) : pick(r, ["order.created", "order.paid", "order.paid", "order.shipped", "order.cancelled"]);
    const value: Record<string, unknown> =
      topic === "payment-events"
        ? { event, payment_id: `pay_${hex(r, 12)}`, order_id: o.id, amount: { value: o.total.toFixed(2), currency: "EUR" }, provider: (o.meta.payment as { provider: string }).provider, attempt: 1 + (i % 3 === 0 ? 1 : 0) }
        : { event, order_id: o.id, customer_id: o.customer.id, status: event.split(".")[1], amount: { value: o.total.toFixed(2), currency: "EUR" }, items: (o.meta.items as { sku: string; qty: number }[]).map(({ sku, qty }) => ({ sku, qty })), channel: o.meta.channel };
    return {
      partition,
      offset,
      at,
      key: `order-${o.id}`,
      value,
      headers: { "trace-id": hex(r, 16), source: topic === "payment-events" ? "payments-api" : "checkout-api", "content-type": "application/json" },
    };
  });
}

interface KafkaFilter { field: string; op: string; value: string }

function fieldValue(m: KafkaMessage, field: string): unknown {
  if (field === "key") return m.key;
  if (field === "value") return JSON.stringify(m.value);
  if (field.startsWith("header.")) return m.headers[field.slice(7)];
  if (field.startsWith("value.")) {
    let cur: unknown = m.value;
    for (const part of field.slice(6).split(".")) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[part] : undefined;
    return cur;
  }
  return undefined;
}

function matches(m: KafkaMessage, f: KafkaFilter): boolean {
  const v = fieldValue(m, f.field);
  const text = v === undefined || v === null ? null : typeof v === "object" ? JSON.stringify(v) : String(v);
  switch (f.op) {
    case "exists": return text !== null;
    case "eq": return text === f.value;
    case "ne": return text !== f.value;
    case "contains": return text !== null && text.includes(f.value);
    case "not_contains": return text === null || !text.includes(f.value);
    case "gt": return text !== null && Number(text) > Number(f.value);
    case "lt": return text !== null && Number(text) < Number(f.value);
    default: return true;
  }
}

/** Answer to one Kafka form statement ({"kafka":1,...}), shaped like the Rust backend's results. */
export function kafkaQuery(statement: string): QueryResult {
  const form = JSON.parse(statement) as {
    mode: string;
    topic: string;
    read?: { from?: string; limit?: number; partitions?: number[]; filters?: KafkaFilter[] };
    send?: { key?: string; value?: string; partition?: string };
  };
  if (form.mode === "topics") {
    return { columns: [{ name: "topic", type: "string" }, { name: "partitions", type: "number" }], rows: TOPICS.map(([t, p]) => [t, String(p)]), truncated: false, message: null };
  }
  const partitions = TOPICS.find(([name]) => name === form.topic)?.[1] ?? 1;
  if (form.mode === "describe") {
    const rows = Array.from({ length: partitions }, (_, p) => {
      const first = 120_000 + p * 311;
      const next = 182_001 + p * 977;
      return [String(p), String(first), String(next), String(next - first)];
    });
    const total = rows.reduce((sum, row) => sum + Number(row[3]), 0);
    return {
      columns: ["partition", "first_offset", "next_offset", "messages"].map((name) => ({ name, type: "number" })),
      rows,
      truncated: false,
      message: `${form.topic}: ${total.toLocaleString("en-US")} messages kept`,
    };
  }
  if (form.mode === "send") {
    const partition = Math.floor(Math.random() * partitions);
    const offset = 182_001 + partition * 977;
    return {
      columns: [["topic", "string"], ["partition", "number"], ["offset", "number"], ["timestamp", "timestamp tz"], ["key", "string"]].map(([name, type]) => ({ name, type })),
      rows: [[form.topic, String(partition), String(offset), localTime(Date.now()), form.send?.key || null]],
      truncated: false,
      message: `Sent to ${form.topic}, partition ${partition}, offset ${offset}`,
    };
  }
  const read = form.read ?? {};
  const limit = read.limit ?? 100;
  let messages = topicMessages(form.topic);
  if (read.partitions?.length) messages = messages.filter((m) => read.partitions!.includes(m.partition));
  const scanned = messages.length;
  messages = messages.filter((m) => (read.filters ?? []).every((f) => matches(m, f)));
  if (read.from === "oldest") messages.reverse();
  const shown = messages.slice(0, limit);
  const usedPartitions = read.partitions?.length || partitions;
  return {
    columns: [["partition", "number"], ["offset", "number"], ["timestamp", "timestamp tz"], ["key", "string"], ["value", "json"], ["headers", "json"]].map(([name, type]) => ({ name, type })),
    rows: shown.map((m) => [String(m.partition), String(m.offset), localTime(m.at), m.key, JSON.stringify(m.value), JSON.stringify(m.headers)]),
    truncated: messages.length > limit,
    message: `Read ${scanned.toLocaleString("en-US")} messages in ${usedPartitions} partition${usedPartitions === 1 ? "" : "s"}, ${shown.length} matched`,
  };
}
