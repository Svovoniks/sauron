import { describe, expect, test } from "bun:test";
import { formatConnectionUrl, guessEnv, parseConnectionUrl } from "./connUrl";

describe("parseConnectionUrl", () => {
  test("full postgres url", () => {
    expect(parseConnectionUrl("postgresql://analyst:s3cret@pg-replica.prod.internal:5432/shop?sslmode=verify-full")).toEqual({
      db_type: "postgres",
      host: "pg-replica.prod.internal",
      port: "5432",
      username: "analyst",
      password: "s3cret",
      database: "shop",
      ssl_mode: "verify",
      name: "pg-replica",
      env: "prod",
    });
  });
  test("defaults and decoding", () => {
    const p = parseConnectionUrl("postgres://me%40corp:p%2Fw@localhost/db")!;
    expect(p.username).toBe("me@corp");
    expect(p.password).toBe("p/w");
    expect(p.port).toBe("5432");
    expect(p.env).toBe("local");
    expect(p.name).toBe("local");
    expect(p.ssl_mode).toBeUndefined();
  });
  test("verify-ca and libpq certificate files", () => {
    expect(parseConnectionUrl("postgresql://me@db.stg.internal:6433/app?sslmode=verify-ca&sslrootcert=%2Fc%2Froot.pem&sslcert=/c/cert.pem&sslkey=/c/key.pem")).toMatchObject({
      port: "6433",
      ssl_mode: "verify-ca",
      ssl_root_cert: "/c/root.pem",
      ssl_cert: "/c/cert.pem",
      ssl_key: "/c/key.pem",
    });
  });
  test("clickhouse over http and https", () => {
    expect(parseConnectionUrl("http://ch.internal:8123")).toMatchObject({ db_type: "clickhouse", port: "8123", ssl_mode: "disable" });
    expect(parseConnectionUrl("https://ch.internal")).toMatchObject({ db_type: "clickhouse", port: "8443", ssl_mode: "verify" });
    expect(parseConnectionUrl("clickhouse://u@ch.staging.internal/analytics")).toMatchObject({ database: "analytics", env: "staging" });
  });
  test("ipv6 host", () => {
    expect(parseConnectionUrl("postgres://[::1]:6543/x")).toMatchObject({ host: "::1", port: "6543" });
  });
  test("libpq host list with target_session_attrs", () => {
    const h = (n: number) => `pg-node${n}.staging.example.com`;
    expect(parseConnectionUrl(`postgresql://me@${h(1)}:6433,${h(2)}:6433,${h(3)}:6433/app?sslmode=verify-ca&target_session_attrs=read-write`)).toEqual({
      db_type: "postgres",
      host: `${h(1)},${h(2)},${h(3)}`,
      port: "6433",
      username: "me",
      database: "app",
      ssl_mode: "verify-ca",
      target_session_attrs: "read-write",
      name: "pg-node1",
      env: "staging",
    });
  });
  test("host list ports follow libpq: per host, missing means 5432", () => {
    expect(parseConnectionUrl("postgres://u@h1,h2:6433/db")).toMatchObject({ host: "h1,h2", port: "5432,6433" });
    expect(parseConnectionUrl("postgres://u@h1:1,h2:2/db")).toMatchObject({ host: "h1,h2", port: "1,2" });
    expect(parseConnectionUrl("postgres://u@h1,[::1]/db")).toMatchObject({ host: "h1,::1", port: "5432" });
    expect(parseConnectionUrl("postgres://u@h1,,h2/db")).toBeNull();
    expect(parseConnectionUrl("http://ch1,ch2:8123")).toBeNull();
  });
  test("target_session_attrs values", () => {
    const target = (v: string) => parseConnectionUrl(`postgres://h/db?target_session_attrs=${v}`)?.target_session_attrs;
    expect(target("read-only")).toBe("read-only");
    expect(target("any")).toBe("any");
    expect(target("primary")).toBe("read-write");
    expect(target("standby")).toBe("read-only");
    expect(target("prefer-standby")).toBeUndefined();
    expect(parseConnectionUrl("postgres://h/db")?.target_session_attrs).toBeUndefined();
  });
  test("a fragment is ignored", () => {
    expect(parseConnectionUrl("postgres://h:1/db#x")).toMatchObject({ host: "h", port: "1", database: "db" });
  });
  test("not a url", () => {
    expect(parseConnectionUrl("hello")).toBeNull();
    expect(parseConnectionUrl("")).toBeNull();
    expect(parseConnectionUrl("mysql://x")).toBeNull();
  });
});

describe("guessEnv", () => {
  test("host name hints", () => {
    expect(guessEnv("db.prod.example.com")).toBe("prod");
    expect(guessEnv("db-staging.example.com")).toBe("staging");
    expect(guessEnv("127.0.0.1")).toBe("local");
    expect(guessEnv("db.example.com")).toBe("");
    expect(guessEnv("producer.example.com")).toBe("");
  });
});

describe("formatConnectionUrl", () => {
  test("no password, tls mode included", () => {
    expect(formatConnectionUrl({ db_type: "postgres", host: "h", port: "5432", database: "d", username: "u", ssl_mode: "verify" })).toBe("postgresql://u@h:5432/d?sslmode=verify-full");
    expect(formatConnectionUrl({ db_type: "clickhouse", host: "h", port: "8123", database: "", username: "", ssl_mode: "disable" })).toBe("http://h:8123");
    expect(
      formatConnectionUrl({ db_type: "postgres", host: "h", port: "6433", database: "d", username: "u", ssl_mode: "verify-ca", ssl_root_cert: "/c/root.pem", ssl_cert: "", ssl_key: "/c/k.pem" }),
    ).toBe("postgresql://u@h:6433/d?sslmode=verify-ca&sslrootcert=%2Fc%2Froot.pem&sslkey=%2Fc%2Fk.pem");
  });
  test("host list: every host gets its port, target session only when not any", () => {
    const base = { db_type: "postgres", database: "d", username: "u", ssl_mode: "require" } as const;
    const url = formatConnectionUrl({ ...base, host: "a, b,c", port: "6433", target_session_attrs: "read-write" });
    expect(url).toBe("postgresql://u@a:6433,b:6433,c:6433/d?sslmode=require&target_session_attrs=read-write");
    expect(parseConnectionUrl(url)).toMatchObject({ host: "a,b,c", port: "6433", target_session_attrs: "read-write" });
    expect(formatConnectionUrl({ ...base, host: "a,::1", port: "1,2", target_session_attrs: "any" })).toBe("postgresql://u@a:1,[::1]:2/d?sslmode=require");
  });
});
