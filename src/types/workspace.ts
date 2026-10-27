import type { QueryResult, StatementError } from "./app";

/** One editor tab. Tabs are persisted (session.json); their results are not. */
export interface QueryTab {
  id: string;
  name: string;
  /** Connection the tab runs on; null until one is chosen. */
  connectionId: string | null;
  sql: string;
  /** Saved query this tab was loaded from / saved as (to show unsaved edits and overwrite it). */
  savedQueryId: string | null;
  savedScope: string | null;
  pinned: boolean;
}

/** Result of one statement of a run. */
export interface ResultSet {
  sql: string;
  /** "select", "update", "psql", ... */
  label: string;
  elapsedMs: number;
  result: QueryResult | null;
  error: StatementError | null;
  /** Offset of the statement inside the text that was run (to put error markers in the editor). */
  offset: number;
}

export type RunStatus = "running" | "done";

/** The latest run of a tab. Kept in memory only. */
export interface TabRun {
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  connectionId: string;
  connectionName: string;
  /** The text sent to the database and where it starts inside the editor text (-1 = unknown). */
  runSql: string;
  runOffset: number;
  rowLimit: number;
  sets: ResultSet[];
  /** Index into `sets`, or MESSAGES for the log. */
  activeSet: number;
  /** Output of a backslash command. */
  meta: { text: string } | null;
  /** The run failed as a whole (could not connect, aborted, ...). */
  error: string | null;
  /** Set when the run replayed a result (no database involved): where it came from, shown above the table. */
  resultSource: string | null;
  /** Timeout override this run used, if any. */
  timeoutSecs: number | null;
}

export const MESSAGES = -1;

export const isRunning = (run: TabRun | null | undefined) => run?.status === "running";
