import type { Connection, ConnectionDraft, Env, SslMode } from "../types/app";

/** Fields a pasted URL can fill in. Anything the URL does not say stays undefined. */
export type ParsedUrl = Partial<Pick<ConnectionDraft, "db_type" | "host" | "port" | "database" | "username" | "password" | "ssl_mode" | "ssl_root_cert" | "ssl_cert" | "ssl_key" | "name" | "env">>;

const URL_RE = /^(postgres(?:ql)?|clickhouse|https?):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?(\[[^\]]+\]|[^:/?#]+)(?::(\d+))?(?:\/([^?#]*))?(?:\?([^#]*))?/i;

/** libpq's certificate file parameters and the connection fields they fill. */
const CERT_PARAMS = [
  ["sslrootcert", "ssl_root_cert"],
  ["sslcert", "ssl_cert"],
  ["sslkey", "ssl_key"],
] as const;

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Guess the environment from the host name: ".prod.", "-staging", ... */
export function guessEnv(host: string): Env {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h.endsWith(".local") || h.endsWith(".localhost")) return "local";
  if (/(^|[.\-_])(prod|production|prd)([.\-_]|$)/.test(h)) return "prod";
  if (/(^|[.\-_])(stag|staging|stg|preprod|qa|uat)([.\-_]|$)/.test(h)) return "staging";
  return "";
}

/** `postgresql://user:pw@host:5432/db?sslmode=verify-full`, `clickhouse://…`, `https://host:8443` -> form fields. */
export function parseConnectionUrl(text: string): ParsedUrl | null {
  const match = URL_RE.exec(text.trim());
  if (!match) return null;
  const [, scheme, user, password, rawHost, port, database, query] = match;
  const host = rawHost.replace(/^\[|\]$/g, "");
  const lower = scheme.toLowerCase();
  const postgres = lower.startsWith("post");
  const params = new URLSearchParams(query ?? "");

  const parsed: ParsedUrl = {
    db_type: postgres ? "postgres" : "clickhouse",
    host,
    port: port ?? (postgres ? "5432" : lower === "https" ? "8443" : "8123"),
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

/** Connection URL without the password, for "Copy connection URL". */
export function formatConnectionUrl(
  c: Pick<Connection, "db_type" | "host" | "port" | "database" | "username" | "ssl_mode"> & Partial<Pick<Connection, "ssl_root_cert" | "ssl_cert" | "ssl_key">>,
): string {
  const user = c.username ? `${encodeURIComponent(c.username)}@` : "";
  const host = c.host.includes(":") && !c.host.startsWith("[") ? `[${c.host}]` : c.host;
  const db = c.database ? `/${encodeURIComponent(c.database)}` : "";
  if (c.db_type === "postgres") {
    const mode = c.ssl_mode === "verify" ? "verify-full" : c.ssl_mode;
    const certs = CERT_PARAMS.filter(([, field]) => c[field]).map(([param, field]) => `&${param}=${encodeURIComponent(c[field] ?? "")}`).join("");
    return `postgresql://${user}${host}:${c.port}${db}?sslmode=${mode}${certs}`;
  }
  return `${c.ssl_mode === "disable" ? "http" : "https"}://${user}${host}:${c.port}${db}`;
}
