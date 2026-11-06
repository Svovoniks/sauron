/** One node of a Postgres host list as the connection form edits it. */
export interface HostRow {
  host: string;
  port: string;
}

/**
 * The saved host and port fields as form rows. The port field holds one port for every host or
 * one port per host (libpq's rule); each row gets its own.
 */
export function toHostRows(host: string, port: string): HostRow[] {
  const hosts = host
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const ports = port.split(",").map((p) => p.trim());
  if (hosts.length === 0) return [{ host: "", port: ports[0] ?? "" }];
  return hosts.map((h, i) => ({ host: h, port: (ports.length === hosts.length ? ports[i] : ports[0]) ?? "" }));
}

/**
 * Form rows back to the saved fields. Rows without a host are left out; the port is written once
 * when every host uses the same one, otherwise as a list with one port per host.
 */
export function fromHostRows(rows: HostRow[]): { host: string; port: string } {
  const filled = rows.filter((row) => row.host.trim() !== "");
  if (filled.length === 0) return { host: "", port: rows[0]?.port.trim() ?? "" };
  const ports = filled.map((row) => row.port.trim());
  return {
    host: filled.map((row) => row.host.trim()).join(","),
    port: ports.every((p) => p === ports[0]) ? ports[0] : ports.join(","),
  };
}

/** A pasted "h1,h2,h3" in one row becomes one row per host, all on that row's port. */
export function expandPastedHosts(rows: HostRow[], index: number, value: string): HostRow[] {
  if (!value.includes(",")) return rows.map((row, i) => (i === index ? { ...row, host: value } : row));
  const port = rows[index]?.port ?? "";
  const pasted = value
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .map((host) => ({ host, port }));
  return [...rows.slice(0, index), ...(pasted.length ? pasted : [{ host: "", port }]), ...rows.slice(index + 1)];
}
