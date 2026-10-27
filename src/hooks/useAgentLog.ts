import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEntry, AgentTable } from "../lib/agentLog";

/** How often the app looks for new agent calls (a directory listing, the list itself is only read when it changed). */
const POLL_MS = 1500;

/**
 * The agent log, kept up to date while the app runs: agents write it from another process (`sauron --mcp`).
 * `unseen` counts calls that came in since the Agent tab was last open.
 */
export function useAgentLog(open: boolean, onError: (message: string) => void) {
  const [entries, setEntries] = useState<AgentEntry[]>([]);
  const [unseen, setUnseen] = useState(0);
  const latestRef = useRef<string | null | undefined>(undefined);
  const seenRef = useRef<string | null | undefined>(undefined);
  const openRef = useRef(open);
  openRef.current = open;

  const reload = useCallback(async () => {
    const list = await invoke<AgentEntry[]>("agent_log_list");
    setEntries(list);
    const seen = seenRef.current;
    setUnseen(openRef.current || seen === undefined ? 0 : list.filter((e) => seen === null || e.id > seen).length);
  }, []);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const latest = await invoke<string | null>("agent_log_latest");
        if (stopped) return;
        // Calls made before the app started are not "new".
        if (seenRef.current === undefined) seenRef.current = latest;
        if (latest !== latestRef.current) {
          latestRef.current = latest;
          await reload();
        }
      } catch {
        // The log is optional; a failed poll is retried on the next tick.
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [reload]);

  useEffect(() => {
    if (!open) return;
    seenRef.current = latestRef.current;
    setUnseen(0);
  }, [open, entries]);

  const result = useCallback(
    async (id: string): Promise<AgentTable | null> => {
      try {
        return await invoke<AgentTable | null>("agent_log_result", { id });
      } catch (error) {
        onError(`Could not read the agent's result: ${String(error)}`);
        return null;
      }
    },
    [onError],
  );

  const clear = useCallback(async () => {
    try {
      await invoke("agent_log_clear");
      latestRef.current = null;
      seenRef.current = null;
      await reload();
    } catch (error) {
      onError(`Could not clear the agent log: ${String(error)}`);
    }
  }, [onError, reload]);

  return { entries, unseen, result, clear };
}
