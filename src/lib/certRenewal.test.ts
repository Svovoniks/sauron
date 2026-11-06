import { describe, expect, test } from "bun:test";
import { certRenewalText } from "./certRenewal";

describe("certRenewalText", () => {
  test("names the certificate file and the new expiry", () => {
    expect(certRenewalText({ kind: "started", cert: "/Users/me/.pg/client.crt" })).toBe(
      "Client certificate client.crt has expired, renewing it… Finish the login in your browser if it opens one.",
    );
    expect(certRenewalText({ kind: "renewed", cert: "C:\\certs\\client.crt", until: "2026-11-13 08:49 UTC" })).toBe(
      "Client certificate client.crt renewed, valid until 2026-11-13 08:49 UTC.",
    );
  });

  test("ignores notices it does not know", () => {
    expect(certRenewalText({ kind: "failed", cert: "/c.crt" } as never)).toBeNull();
  });
});
