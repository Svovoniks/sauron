import type { Connection, ConnectionDraft, Env, SslMode, TargetSessionAttrs } from "../types/app";

/** Fields a pasted URL can fill in. Anything the URL does not say stays undefined. */
export type ParsedUrl = Partial<
  Pick<ConnectionDraft, "db_type" | "host" | "port" | "database" | "username" | "password" | "ssl_mode" | "ssl_root_cert" | "ssl_cert" | "ssl_key" | "target_session_attrs" | "name" | "env">
>;

/** scheme, user, password, host list (host[:port], comma separated), database, query. */
const URL_RE = /^(postgres(?:ql)?|clickhouse|https?):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/?#@]*)(?:\/([^?#]*))?(?:\?([^#]*))?(?:#.*)?$/i;

/** One entry of the host list: a name or a bracketed IPv6 address, then an optional port. */
const HOST_PORT_RE = /^(\[[^\]]+\]|[^:[\]]+)(?::(\d*))?$/;

/** libpq's certificate file parameters and the connection fields they fill. */
const CERT_PARAMS = [
  ["sslrootcert", "ssl_root_cert"],
  ["sslcert", "ssl_cert"],
  ["sslkey", "ssl_key"],
] as const;

/**
 * libpq's target_session_attrs values. primary and standby are mapped to the closest setting the
 * app supports (it checks whether the session is read-only, not whether the server is in recovery).
 */
const TARGET_PARAM: Record<string, TargetSessionAttrs> = {
  any: "any",
  "read-write": "read-write",
  "read-only": "read-only",
  primary: "read-write",
  standby: "read-only",
};

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Postgres host field split into its hosts: comma separated, blanks dropped. */
export const splitHosts = (host: string) =>
  host
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);

/** Guess the environment from the host name: ".prod.", "-staging", ... */
export function guessEnv(host: string): Env {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h.endsWith(".local") || h.endsWith(".localhost")) return "local";
  if (/(^|[.\-_])(prod|production|prd)([.\-_]|$)/.test(h)) return "prod";
  if (/(^|[.\-_])(stag|staging|stg|preprod|qa|uat)([.\-_]|$)/.test(h)) return "staging";
  return "";
}

/**
 * `postgresql://user:pw@host:5432/db?sslmode=verify-full`, `clickhouse://…`, `https://host:8443` -> form fields.
 * Postgres URLs may list several hosts like libpq does (postgresql://u@h1:6433,h2:6433/db?target_session_attrs=read-write):
 * each host has its own port and one without a port uses 5432, so h1,h2:6433 means h1 on 5432.
 */
export function parseConnectionUrl(text: string): ParsedUrl | null {
  const match = URL_RE.exec(text.trim());
  if (!match) return null;
  const [, scheme, user, password, hostList, database, query] = match;
  const lower = scheme.toLowerCase();
  const postgres = lower.startsWith("post");
  const defaultPort = postgres ? "5432" : lower === "https" ? "8443" : "8123";
  const params = new URLSearchParams(query ?? "");

  const entries = hostList.split(",").map((entry) => HOST_PORT_RE.exec(entry));
  if (entries.length === 0 || entries.some((entry) => entry === null)) return null;
  if (!postgres && entries.length > 1) return null;
  const hosts = entries.map((entry) => entry![1].replace(/^\[|\]$/g, ""));
  const ports = entries.map((entry) => entry![2] || defaultPort);
  const host = hosts[0];

  const parsed: ParsedUrl = {
    db_type: postgres ? "postgres" : "clickhouse",
    host: hosts.join(","),
    // one port for all hosts when they agree, otherwise one per host
    port: ports.every((port) => port === ports[0]) ? ports[0] : ports.join(","),
  };
  if (user) parsed.username = safeDecode(user);
  if (password) parsed.password = safeDecode(password);
  if (database) parsed.database = safeDecode(database);

  const ssl = params.get("sslmode") ?? params.get("ssl_mode");
  if (postgres) {
    if (ssl) parsed.ssl_mode = ssl === "verify-ca" ? "verify-ca" : /^verify/.test(ssl) ? "verify" : (["disable", "prefer", "require"].includes(ssl) ? (ssl as SslMode) : "require");
    for (const [param, field] of CERT_PARAMS) {
      const path = params.get(param);
      if (path) parsed[field] = path;
    }
    const target = TARGET_PARAM[params.get("target_session_attrs") ?? ""];
    if (target) parsed.target_session_attrs = target;
  } else if (lower === "https" || params.get("secure") === "true" || params.get("secure") === "1") {
    parsed.ssl_mode = "verify";
  } else if (lower === "http" || lower === "clickhouse") {
    parsed.ssl_mode = "disable";
  }

  const first = host.split(".")[0];
  parsed.name = guessEnv(host) === "local" ? "local" : first && !/^\d+$/.test(first) ? first : host;
  const env = guessEnv(host);
  if (env) parsed.env = env;
  return parsed;
}

const bracketed = (host: string) => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);

/** Connection URL without the password, for "Copy connection URL". */
export function formatConnectionUrl(
  c: Pick<Connection, "db_type" | "host" | "port" | "database" | "username" | "ssl_mode"> & Partial<Pick<Connection, "ssl_root_cert" | "ssl_cert" | "ssl_key" | "target_session_attrs">>,
): string {
  const user = c.username ? `${encodeURIComponent(c.username)}@` : "";
  const db = c.database ? `/${encodeURIComponent(c.database)}` : "";
  if (c.db_type === "postgres") {
    // Every host gets its port written out: in a libpq URL a host without one would use 5432.
    const hosts = splitHosts(c.host);
    const ports = c.port.split(",").map((p) => p.trim());
    const hostList = (hosts.length ? hosts : [c.host]).map((h, i) => `${bracketed(h)}:${ports.length === hosts.length ? ports[i] : ports[0]}`).join(",");
    const mode = c.ssl_mode === "verify" ? "verify-full" : c.ssl_mode;
    const certs = CERT_PARAMS.filter(([, field]) => c[field]).map(([param, field]) => `&${param}=${encodeURIComponent(c[field] ?? "")}`).join("");
    const target = c.target_session_attrs && c.target_session_attrs !== "any" ? `&target_session_attrs=${c.target_session_attrs}` : "";
    return `postgresql://${user}${hostList}${db}?sslmode=${mode}${certs}${target}`;
  }
  return `${c.ssl_mode === "disable" ? "http" : "https"}://${user}${bracketed(c.host)}:${c.port}${db}`;
}
