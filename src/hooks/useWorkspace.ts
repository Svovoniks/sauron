import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cancelQuery, CANCELLED_MESSAGE, executeMetaCommand, executeScript, isMetaCommand } from "../lib/db/query";
import { statementLabel } from "../lib/sql/analyze";
import { splitSqlRanges } from "../lib/sql/splitStatements";
import { isDirty, newTab, normalizeSession, serializeSession, sortPinned } from "../lib/workspace";
import { readJsonFile, writeFileText } from "../lib/fileStore";
import type { Connection, QueryResult, StatementOutcome } from "../types/app";
import { MESSAGES, type QueryTab, type ResultSet, type TabRun } from "../types/workspace";

/** If the backend does not confirm a cancel within this time, the UI lets go anyway. */
const ABORT_GRACE_MS = 3_000;
const SAVE_DELAY_MS = 500;
export const ABORTED_MESSAGE = "Query was aborted.";

export interface RunRequest {
  tabId: string;
  connection: Connection;
  /** Text to run and its offset inside the tab's editor text. */
  text: string;
  offset: number;
  rowLimit: number;
  psql: { path?: string; useFallback?: boolean };
  /** Run once with this timeout instead of the connection's. */
  timeoutSecs?: number;
}

export interface RunSummary {
  request: RunRequest;
  status: "ok" | "error" | "cancelled";
  ms: number;
  rows: number | null;
  affected: boolean;
  truncated: boolean;
  error: string | null;
  /** The run could not reach the database at all. */
  connectionFailed: boolean;
  sets: ResultSet[];
}

const CONNECTION_FAILURE = /HTTP 40[13]|username and password|error connecting|connection refused|connection reset|broken pipe|could not connect|timed out|no such host|failed to lookup|dns error|network is unreachable|connection closed|unexpected eof|error sending request|tcp connect/i;
export const looksLikeConnectionFailure = (message: string) => CONNECTION_FAILURE.test(message);

const labelOf = (outcome: StatementOutcome) => statementLabel(outcome.sql);

function summarize(request: RunRequest, sets: ResultSet[], ms: number, error: string | null, cancelled: boolean): RunSummary {
  const failedSet = sets.find((set) => set.error);
  const last = sets[sets.length - 1]?.result ?? null;
  const message = error ?? failedSet?.error?.message ?? null;
  const isCancelled = cancelled || message === CANCELLED_MESSAGE || message === ABORTED_MESSAGE;
  return {
    request,
    status: isCancelled ? "cancelled" : message ? "error" : "ok",
    ms,
    rows: last ? (last.columns.length > 0 ? last.rows.length : affectedRows(last)) : null,
    affected: last ? last.columns.length === 0 && affectedRows(last) !== null : false,
    truncated: Boolean(last?.truncated),
    error: message,
    // ClickHouse reports transport / login problems as the failed statement's error, with no error code.
    connectionFailed: !isCancelled && message !== null && (error !== null || (failedSet?.error?.code ?? null) === null) && looksLikeConnectionFailure(message),
    sets,
  };
}

const affectedRows = (result: QueryResult): number | null => {
  const m = /^(\d[\d,]*) rows? (?:affected|written)/.exec(result.message ?? "");
  return m ? Number(m[1].replace(/,/g, "")) : null;
};

interface Options {
  /** Wait for the app data / settings before creating the first tab. */
  ready: boolean;
  connections: Connection[];
  restoreSession: boolean;
  /** Saved query text lookup for the "unsaved changes" dot. */
  savedText: (tab: QueryTab) => string | null;
  onRunFinished: (summary: RunSummary) => void;
  onError: (message: string) => void;
}

/** Query tabs (persisted) and the latest run of each (memory only). Only one query runs at a time. */
export function useWorkspace(options: Options) {
  const [tabs, setTabs] = useState<QueryTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, TabRun>>({});
  const [initialized, setInitialized] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(activeTabId);
  activeRef.current = activeTabId;

  // --- first tabs ------------------------------------------------------------------------------
  useEffect(() => {
    if (!options.ready || initialized) return;
    let cancelled = false;
    (async () => {
      let restored = { activeTabId: null as string | null, tabs: [] as QueryTab[] };
      if (options.restoreSession) {
        try {
          restored = normalizeSession(await readJsonFile("session"), options.connections);
        } catch (error) {
          optionsRef.current.onError(`Could not restore the last session: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (cancelled) return;
      if (restored.tabs.length === 0) {
        const first = newTab({ sql: "SELECT 1" });
        restored = { activeTabId: first.id, tabs: [first] };
      }
      setTabs(restored.tabs);
      setActiveTabId(restored.activeTabId);
      setInitialized(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [options.ready, options.restoreSession, options.connections, initialized]);

  // --- persistence -------------------------------------------------------------------------------
  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!initialized) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const content = optionsRef.current.restoreSession ? serializeSession({ activeTabId, tabs }) : serializeSession({ activeTabId: null, tabs: [] });
      writeFileText("session", content).catch((error) => optionsRef.current.onError(`Could not save your tabs: ${error instanceof Error ? error.message : String(error)}`));
    }, SAVE_DELAY_MS);
  }, [tabs, activeTabId, initialized, options.restoreSession]);

  useEffect(() => {
    const flush = () => {
      if (!initialized) return;
      window.clearTimeout(saveTimer.current);
      const o = optionsRef.current;
      void writeFileText("session", o.restoreSession ? serializeSession({ activeTabId: activeRef.current, tabs: tabsRef.current }) : serializeSession({ activeTabId: null, tabs: [] }));
    };
    const onVisibility = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, [initialized]);

  // --- tab operations ----------------------------------------------------------------------------
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) ?? null, [tabs, activeTabId]);

  const patchTab = useCallback((id: string, patch: Partial<QueryTab>) => {
    setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)));
  }, []);

  const addTab = useCallback((init: Partial<QueryTab> = {}) => {
    const tab = newTab(init, tabsRef.current);
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
    return tab;
  }, []);

  /** Removes a tab; returns the ids of tabs that no longer exist. */
  const closeTabs = useCallback((ids: string[]) => {
    const current = tabsRef.current;
    const closing = new Set(ids);
    let remaining = current.filter((tab) => !closing.has(tab.id));
    let next = activeRef.current;
    if (next && closing.has(next)) {
      const at = current.findIndex((tab) => tab.id === next);
      next = (remaining.find((tab) => current.indexOf(tab) > at) ?? remaining[remaining.length - 1])?.id ?? null;
    }
    if (remaining.length === 0) {
      const fresh = newTab({}, []);
      remaining = [fresh];
      next = fresh.id;
    }
    setTabs(remaining);
    setActiveTabId(next);
    setRuns((r) => {
      const copy = { ...r };
      ids.forEach((id) => delete copy[id]);
      return copy;
    });
    return ids;
  }, []);

  const moveTab = useCallback((fromId: string, toId: string) => {
    setTabs((current) => {
      const from = current.findIndex((t) => t.id === fromId);
      const to = current.findIndex((t) => t.id === toId);
      if (from < 0 || to < 0 || from === to) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const togglePin = useCallback((id: string) => {
    setTabs((current) => sortPinned(current.map((tab) => (tab.id === id ? { ...tab, pinned: !tab.pinned } : tab))));
  }, []);

  const duplicateTab = useCallback((id: string) => {
    const source = tabsRef.current.find((t) => t.id === id);
    if (!source) return;
    const copy = newTab({ name: `${source.name} copy`, connectionId: source.connectionId, sql: source.sql }, tabsRef.current);
    setTabs((current) => {
      const index = current.findIndex((t) => t.id === id);
      return [...current.slice(0, index + 1), copy, ...current.slice(index + 1)];
    });
    setActiveTabId(copy.id);
  }, []);

  // --- runs ------------------------------------------------------------------------------------
  const activeRun = useRef<{ id: number; tabId: string; request: RunRequest; startedAt: number } | null>(null);
  const nextRun = useRef(1);
  const [runningTabId, setRunningTabId] = useState<string | null>(null);

  const setRun = useCallback((tabId: string, run: TabRun) => setRuns((current) => ({ ...current, [tabId]: run })), []);
  const patchRun = useCallback(
    (tabId: string, patch: Partial<TabRun>) => setRuns((current) => (current[tabId] ? { ...current, [tabId]: { ...current[tabId], ...patch } } : current)),
    [],
  );

  const finish = useCallback((id: number, apply: () => void) => {
    if (activeRun.current?.id !== id) return false;
    activeRun.current = null;
    // A transition: showing a big result takes a while to render, and this lets React do it in slices between frames
    // instead of in one block that freezes the loading animation.
    startTransition(() => {
      setRunningTabId(null);
      apply();
    });
    return true;
  }, []);

  const startRun = useCallback(
    (request: RunRequest): boolean => {
      if (activeRun.current !== null) return false;
      const id = nextRun.current++;
      const { tabId, connection } = request;
      const startedAt = Date.now();
      activeRun.current = { id, tabId, request, startedAt };
      setRunningTabId(tabId);
      const base: TabRun = {
        status: "running",
        startedAt,
        finishedAt: null,
        connectionId: connection.id,
        connectionName: connection.name,
        runSql: request.text,
        runOffset: request.offset,
        rowLimit: request.rowLimit,
        sets: [],
        activeSet: 0,
        meta: null,
        error: null,
        savedResultName: null,
        timeoutSecs: request.timeoutSecs ?? null,
      };
      setRun(tabId, base);

      const done = (patch: Partial<TabRun>, sets: ResultSet[], error: string | null, cancelled = false) => {
        const ms = Date.now() - startedAt;
        const finished = finish(id, () => {
          // The tab may have been closed while the query ran.
          if (!tabsRef.current.some((tab) => tab.id === tabId)) return;
          const firstError = sets.findIndex((set) => set.error);
          setRun(tabId, { ...base, ...patch, status: "done", finishedAt: Date.now(), sets, error, activeSet: firstError >= 0 ? firstError : Math.max(0, sets.length - 1) });
        });
        if (finished) optionsRef.current.onRunFinished(summarize(request, sets, ms, error, cancelled));
      };
      const fail = (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        done({}, [], message, message === CANCELLED_MESSAGE);
      };

      const effective = request.timeoutSecs !== undefined ? { ...connection, timeout_secs: request.timeoutSecs } : connection;

      if (isMetaCommand(request.text)) {
        executeMetaCommand(effective, request.text, request.psql)
          .then((output) => done({ meta: { text: output.text } }, [], null))
          .catch(fail);
        return true;
      }

      const ranges = splitSqlRanges(request.text, connection.db_type);
      if (ranges.length === 0) {
        fail(new Error("No SQL statement to execute."));
        return true;
      }
      executeScript(effective, ranges.map((r) => r.text), request.rowLimit)
        .then((outcomes) =>
          done(
            {},
            outcomes.map((o, i): ResultSet => ({ sql: o.sql, label: labelOf(o), elapsedMs: o.elapsed_ms, result: o.result, error: o.error, offset: request.offset + (ranges[i]?.start ?? 0) })),
            null,
          ),
        )
        .catch(fail);
      return true;
    },
    [finish, setRun],
  );

  const abort = useCallback(() => {
    const current = activeRun.current;
    if (!current) return;
    void cancelQuery();
    window.setTimeout(() => {
      if (activeRun.current?.id !== current.id) return;
      const finished = finish(current.id, () => {
        if (!tabsRef.current.some((tab) => tab.id === current.tabId)) return;
        setRuns((r) => (r[current.tabId] ? { ...r, [current.tabId]: { ...r[current.tabId], status: "done", finishedAt: Date.now(), sets: [], error: ABORTED_MESSAGE } } : r));
      });
      if (finished) optionsRef.current.onRunFinished(summarize(current.request, [], Date.now() - current.startedAt, ABORTED_MESSAGE, true));
    }, ABORT_GRACE_MS);
  }, [finish]);

  const showSavedResult = useCallback(
    (tabId: string, result: QueryResult, name: string, connectionId: string | null, connectionName: string, sql: string) => {
      setRun(tabId, {
        status: "done",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        connectionId: connectionId ?? "",
        connectionName,
        runSql: sql,
        runOffset: -1,
        rowLimit: result.rows.length,
        sets: [{ sql, label: "saved", elapsedMs: 0, result, error: null, offset: -1 }],
        activeSet: 0,
        meta: null,
        error: null,
        savedResultName: name,
        timeoutSecs: null,
      });
    },
    [setRun],
  );

  const reportError = useCallback(
    (tabId: string, message: string) =>
      setRun(tabId, { status: "done", startedAt: Date.now(), finishedAt: Date.now(), connectionId: "", connectionName: "", runSql: "", runOffset: -1, rowLimit: 0, sets: [], activeSet: 0, meta: null, error: message, savedResultName: null, timeoutSecs: null }),
    [setRun],
  );

  const selectSet = useCallback((tabId: string, index: number) => patchRun(tabId, { activeSet: index }), [patchRun]);

  const dirtyTabs = useMemo(() => new Set(tabs.filter((tab) => isDirty(tab, options.savedText(tab))).map((tab) => tab.id)), [tabs, options]);

  return {
    tabs,
    activeTab,
    activeTabId,
    setActiveTabId,
    initialized,
    runs,
    runningTabId,
    dirtyTabs,
    patchTab,
    addTab,
    closeTabs,
    moveTab,
    togglePin,
    duplicateTab,
    startRun,
    abort,
    showSavedResult,
    reportError,
    selectSet,
    MESSAGES,
  };
}
