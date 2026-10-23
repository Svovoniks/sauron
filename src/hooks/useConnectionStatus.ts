import { useCallback, useState } from "react";

/** "checking": a check started by selecting the connection is in flight. */
export type ConnState = "" | "checking" | "ok" | "err";

export interface ConnStatus {
  state: ConnState;
  version: string | null;
  /** Last error for a failed connection. */
  error: string | null;
}

const UNKNOWN: ConnStatus = { state: "", version: null, error: null };

/** What we know about each connection from the runs and tests so far (nothing connects on its own). */
export function useConnectionStatus() {
  const [status, setStatus] = useState<Record<string, ConnStatus>>({});

  const mark = useCallback((id: string, patch: Partial<ConnStatus> & { state: ConnState }) => {
    setStatus((current) => {
      const previous = current[id] ?? UNKNOWN;
      const next = { ...previous, error: null, ...patch };
      if (previous.state === next.state && previous.version === next.version && previous.error === next.error) return current;
      return { ...current, [id]: next };
    });
  }, []);

  const get = useCallback((id: string | null): ConnStatus => (id ? (status[id] ?? UNKNOWN) : UNKNOWN), [status]);

  return { get, mark };
}
