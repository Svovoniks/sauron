/** What the backend sends as "cert-renewal" when a connect renews an expired client certificate by itself. */
export type CertRenewalNotice = { kind: "started"; cert: string } | { kind: "renewed"; cert: string; until: string };

export const CERT_RENEWAL_EVENT = "cert-renewal";

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** The notification text for a renewal notice (null for anything this version does not know). */
export function certRenewalText(notice: CertRenewalNotice): string | null {
  const name = fileName(notice.cert);
  if (notice.kind === "started") return `Client certificate ${name} has expired, renewing it… Finish the login in your browser if it opens one.`;
  if (notice.kind === "renewed") return `Client certificate ${name} renewed, valid until ${notice.until}.`;
  return null;
}
