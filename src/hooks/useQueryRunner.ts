import { useCallback, useRef, useState } from "react";
import {
  cancelQuery,
  DEFAULT_ROW_LIMIT,
  executeMetaCommand,
  executeQuery,
  isMetaCommand,
} from "../lib/db/query";
import { splitSqlStatements } from "../lib/sql/splitStatements";
import type { Connection, QueryResult } from "../types/app";

/** Output of a backslash command: psql-style text. */
export interface MetaOutput {
  text: string;
}

export interface LastRun {
  sql: string;
  connection: Connection;
  rowLimit: number;
}

/** If the backend does not confirm a cancel within this time, the UI lets go anyway. */
const ABORT_GRACE_MS = 3_000;

export function useQueryRunner() {
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  /** Connection the shown result came from. */
  const [resultConnectionId, setResultConnectionId] = useState<string | null>(null);
  const [metaOutput, setMetaOutput] = useState<MetaOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);

  /** Id of the run whose answer we are waiting for; any other answer is stale and ignored. */
  const activeRun = useRef<number | null>(null);
  const nextRun = useRef(1);

  const finish = useCallback((run: number, apply: () => void) => {
    if (activeRun.current !== run) return;
    activeRun.current = null;
    apply();
    setIsLoading(false);
  }, []);

  const run = useCallback(
    (connection: Connection, sql: string, rowLimit = DEFAULT_ROW_LIMIT) => {
      if (activeRun.current !== null) return;
      const id = nextRun.current++;
      activeRun.current = id;

      setIsLoading(true);
      setError(null);
      setMetaOutput(null);
      setLastRun({ sql, connection, rowLimit });

      const fail = (e: unknown) =>
        finish(id, () => {
          setResult(null);
          setError(e instanceof Error ? e.message : String(e));
        });

      if (isMetaCommand(sql)) {
        executeMetaCommand(connection, sql)
          .then((output) =>
            finish(id, () => {
              setResult(null);
              setMetaOutput({ text: output.text });
            }),
          )
          .catch(fail);
        return;
      }

      const statements = splitSqlStatements(sql, connection.db_type);
      if (statements.length === 0) {
        fail(new Error("No SQL statement to execute."));
        return;
      }

      executeQuery(connection, statements, rowLimit)
        .then((next) =>
          finish(id, () => {
            setResult(next);
            setResultConnectionId(connection.id);
          }),
        )
        .catch(fail);
    },
    [finish],
  );

  const abort = useCallback(() => {
    const id = activeRun.current;
    if (id === null) return;
    void cancelQuery();
    window.setTimeout(() => {
      finish(id, () => {
        setResult(null);
        setError("Query was aborted.");
      });
    }, ABORT_GRACE_MS);
  }, [finish]);

  const reportError = useCallback((message: string) => {
    setResult(null);
    setMetaOutput(null);
    setError(message);
  }, []);

  const showSavedResult = useCallback((saved: QueryResult, connectionId: string | null) => {
    setResult(saved);
    setResultConnectionId(connectionId);
    setMetaOutput(null);
    setError(null);
    setLastRun(null);
  }, []);

  return { isLoading, result, resultConnectionId, metaOutput, error, lastRun, run, abort, reportError, showSavedResult };
}
