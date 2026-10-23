import { invoke } from "@tauri-apps/api/core";
import type { Connection, MetaResult, StatementOutcome, TestReport } from "../../types/app";

/** Default / maximum number of rows fetched per query. Keep in sync with MAX_ROW_LIMIT in lib.rs. */
export const MAX_ROW_LIMIT = 1_000_000;

/** Message produced by the backend when a query is stopped by the user. */
export const CANCELLED_MESSAGE = "Query was cancelled";

/** Tauri rejects with plain strings; make them real errors. */
const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/** Runs a script in one session; one outcome per statement, stopping at the first error. */
export async function executeScript(
  connection: Connection,
  statements: string[],
  rowLimit: number,
  /** Background work (schema loading) is not stopped by Abort and does not stop a running query. */
  background = false,
): Promise<StatementOutcome[]> {
  try {
    return await invoke<StatementOutcome[]>("execute_script", { connection, statements, rowLimit, background });
  } catch (error) {
    throw toError(error);
  }
}

/** Step-by-step connection check. An explicit password (not saved yet) wins over the keychain. */
export async function testConnection(connection: Connection, password?: string): Promise<TestReport> {
  try {
    return await invoke<TestReport>("test_connection", { connection, password: password || null });
  } catch (error) {
    throw toError(error);
  }
}

/** Backslash commands (`\dt`, `\d table`, ...), implemented natively - no psql needed. */
export async function executeMetaCommand(
  connection: Connection,
  commandText: string,
  psql: { path?: string; useFallback?: boolean } = {},
): Promise<MetaResult> {
  try {
    return await invoke<MetaResult>("execute_meta_command", {
      connection,
      commandText,
      psqlPath: psql.path || null,
      useFallback: psql.useFallback ?? true,
    });
  } catch (error) {
    throw toError(error);
  }
}

export async function cancelQuery(): Promise<void> {
  try {
    await invoke("cancel_query");
  } catch (error) {
    console.warn("Failed to cancel the query.", error);
  }
}

export const isMetaCommand = (query: string) => query.trimStart().startsWith("\\");
